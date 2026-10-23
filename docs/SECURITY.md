# 安全模型：密钥隔离与角色权限

> 配套 `ARCHITECTURE.md` / `MODEL-ACCESS.md`。
> 唯一硬性目标：**用户上传的 API Key，只有该用户本人能看到明文。部署者（superadmin）拥有全部系统权限，但不包括这一项。**

---

## 1. 先说边界：能做到什么，做不到什么

这一节必须先写，否则后面所有机制都是虚假安全承诺。

| 攻击者具备的能力 | 能否拿到明文 Key |
|---|---|
| 拿到数据库文件或备份 | **不能**（库里只有密文，以及被用户密码包裹的 DEK） |
| 以 superadmin 登录后台，翻遍所有页面 | **不能**（没有解密路径，接口层只返回掩码） |
| 直接调 API、构造参数 | **不能**（返回类型里根本没有密钥字段） |
| 拿到服务器 root，读环境变量与配置文件 | **不能**（环境里没有用户 DEK，只有用户自己的密码能解出来） |
| 重置某个用户的密码，然后用新密码登录 | **不能**（重置会销毁 `wrappedDek`，Key 变成永久不可解，只能报废重录） |
| 有 root + 愿意改代码 + 在用户解锁期间 dump 进程内存 | **能** |

最后一行必须承认。只要服务端要用这把 Key 去调 DeepSeek，运行时它就必然在内存里是明文——这是架构决定的，不是实现缺陷。

所以本方案的真实目标是：

> 在**不改代码、不抓内存**的前提下，部署者通过任何界面、接口、数据库、备份，都拿不到用户的 Key。

要防住"有 root 且主动攻击"的部署者，需要 TEE / HSM / 客户端持钥，成本和复杂度远超一个自用工具该承受的范围。本文档选择在前一条线上做到扎实，而不是在后一条线上做一个会被戳穿的承诺。

---

## 2. 核心机制：信封加密（每用户独立 DEK）

问题的根源在于：**如果所有 Key 用同一个全局主密钥加密，那么持有主密钥的人就能解开全部 Key。** 部署者必然持有主密钥，所以全局加密在这个需求下等于没加密。

解法是让每把 Key 的加密材料**绑定到用户密码**，而服务端不保存这份材料：

```
                       用户密码（只有用户知道）
                            │
                   Argon2id(keySalt, m=64MB, t=3, p=4)
                            ▼
                        KEK (32B，只在内存，永不落库)
                            │  解密
                            ▼
                    wrappedDek ──► DEK (32B，每用户一个)
                                      │  AES-256-GCM
                                      ▼
                                   apiKeyEnc ──► 存库
```

三条链路的要点：

| 材料 | 存在哪 | 谁能得到 |
|---|---|---|
| `keySalt` | 数据库明文 | 所有人（但它只是盐，没有密码没用） |
| `wrappedDek` | 数据库密文 | 所有人（但解开它需要 KEK，KEK 需要密码） |
| DEK | 只在内存 | 只有知道密码的用户，登录/解锁后可得到 |
| `apiKeyEnc` | 数据库密文 | 所有人（解开它需要 DEK） |

部署者拿到整库 + 整台服务器，缺的恰恰是**用户脑子里的那串密码**。

### 参数（写死在代码里，不允许配置放宽）

| 项 | 值 |
|---|---|
| KDF | Argon2id |
| Argon2 参数 | memory 64 MiB, iterations 3, parallelism 4, hashLen 32 |
| keySalt | 16B 随机，每用户独立 |
| DEK | 32B 随机，每用户独立 |
| 对称加密 | AES-256-GCM，12B IV，16B tag |
| 密文格式 | `dek:v1:<base64(iv)>:<base64(tag)>:<base64(cipher)>` |
| wrappedDek 格式 | `wrap:v1:<base64(iv)>:<base64(tag)>:<base64(cipher)>` |

`dek:v1:` 这个前缀不只是标记，它让迁移脚本能扫出"历史上被全局 KEK 加密过的旧数据"并强制重新录入——**不允许存在两种解密路径**，因为这正是后门最容易藏身的地方。

---

## 3. DEK 的生命周期（含一个必须接受的取舍）

### 3.1 解锁与驻留

```
登录成功 → 派生 KEK → 解开 wrappedDek → DEK 放入运行时密钥库（内存 Map，key=sessionId）
                                              ↓
                                    进程内所有加解密都从这里取
会话过期 / 主动锁定 → 从 Map 中删除，GC 回收
```

**不落盘、不进 Redis、不进日志。** 只有内存。

### 3.2 由此产生的取舍：服务重启后需要重新解锁

机器人是 7×24 跑的，但 DEK 只在用户登录后存在于内存。这就产生一个真实矛盾：

> 服务重启 → DEK 丢失 → 机器人无法调用 LLM。

三个选项，我们选第二个：

| 方案 | 后果 | 结论 |
|---|---|---|
| 把 DEK 用服务端 KEK 再包一层存库 | 部署者持有 KEK → 可解密全部 Key | **否决，直接违背需求** |
| 需要用户重新解锁 | 重启后需进后台点一次"解锁" | **采用** |
| 明文存 DEK | 等同于不加密 | 否决 |

解锁体验上的处理：

- 解锁态默认保持到会话结束，可配 TTL（建议 7 天，仅内存计时器，重启即失效）
- 未解锁时机器人**不静默失败**：检测到 LLM 调用缺少 DEK，改为发送预设话术（"我这边有点事，等下再说"），并给 owner 推一条通知「需要解锁才能继续对话」
- 后台首页有一个常驻状态条：已解锁 / 需解锁

对自用工具来说，"重启后点一下"是可以接受的成本；换来的是部署者真的看不到你的 Key。

### 3.3 进程内存里到底有什么（重启会丢什么）

这张表是为了回答一个具体问题："服务器重启会不会把用户弄丢？"
**不会。** 用户、密码哈希、keySalt、wrappedDek、凭据密文、审计日志全部在 SQLite 里。
内存里只有下面这几样，且都是**可重建**的：

| 内存中的东西 | 位置 | 重启后果 | 严重性 |
|---|---|---|---|
| DEK（每会话一把） | `RuntimeKeyStore.sessions` | 消失，需重新解锁（登录即解锁） | **设计如此**（D005），不是故障 |
| 会话记录（userId/role/TTL） | `SessionService.sessions` | 消失，cookie 立刻失效，需重新登录 | 预期行为，数据无损 |
| 解锁/会话过期计时 | 上述两个 Map 的 `expiresAt` | 随会话一起消失 | 无影响 |
| 审计时间戳下限 | `AuditService.lastCreatedAt` | 归零，但**会从数据库最后一条重建下限**（见下） | 已消除 |
| 解密过程中的 DEK / KEK 副本 | 方法局部变量 | 随 GC 回收 | 无影响 |
| 未完成的请求 | 进程栈 | 请求失败（客户端重试） | 无数据写入丢失 |

一个容易忽略的点：审计的 `createdAt` 必须严格递增，否则按时间重算哈希链会误报断链。
这个"上一条时间"如果只放内存，重启后遇到时钟回拨（NTP 校正、容器时钟漂移）就会排到历史记录前面。
所以现在的下限来自**数据库最后一条记录**，内存字段只是快路径 —— 重启不会破坏审计链。

> 判断标准：任何"重启就丢"的东西，必须是**能从数据库重建**或**本来就该由用户重新提供**的。
> 如果哪天有人往内存里塞了"用户创建时间""首次登录标记"这类不可重建的状态，那就是 bug。

---

## 4. 角色与权限矩阵

用户提出的模型是两级：**部署者 = superadmin（全权限）**、**普通 user**。用户管理接口本次预留，主体完成后再做。

关键在于：**"系统权限"和"数据可见性"是两套东西。**

| 权限 | superadmin | user（本人） | user（他人） |
|---|---|---|---|
| 系统配置、模型预设维护 | 有 | 无 | 无 |
| 创建 / 停用 / 重置用户 | 有 | 无 | 无 |
| 查看全部实例、人设、会话日志 | 有 | 仅自己 | 无 |
| 紧急停用任意用户的 Key | 有 | 有（自己的） | 无 |
| 查看 Key 的掩码、Provider、用量 | 有（脱敏） | 有 | 无 |
| **读取 Key 明文** | **不存在此权限** | 有（仅本人） | 无 |
| 导出 Key | 无 | 无 | 无 |
| 查看审计日志 | 有 | 仅与自己相关的 | 无 |
| 删除审计日志 | 无（任何人都不行） | 无 | 无 |

注意第一列倒数第三行写的是"**不存在此权限**"，不是"没有授予"。这是刻意的：

> 权限枚举里根本不存在 `credential.read.plaintext` 这个 action。
> 不是靠 `if (role !== 'owner') throw` 挡住，而是**没有任何代码路径能授予它**。

这比运行时判断可靠得多——运行时判断会在某次重构、某个新增接口、某次"临时排查问题"里被绕过。

### 4.1 预留的用户管理接口

本次不实现，但先占位，避免后期改路由：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/users` | 列表（绝不返回 wrappedDek / keySalt） |
| POST | `/api/admin/users` | 创建用户（生成 keySalt，等用户首次登录时生成 DEK） |
| PATCH | `/api/admin/users/:id` | 改显示名、角色、启停 |
| POST | `/api/auth/password` | **本人改密码**：校验旧密码，重包裹 DEK，Key 不受影响 |
| POST | `/api/admin/users/:id/reset-password` | **管理员重置**：销毁 `wrappedDek`，该用户 Key 全部报废，见 5.1 |
| GET | `/api/admin/audit` | 审计日志（可校验哈希链） |
| GET | `/api/admin/usage/summary` | 全站用量聚合（不含单 Key 明细） |

---

## 5. 三个最容易漏的洞

### 5.1 密码变更：两条路径，必须分开实现

这是整个方案里最危险的一处，因为**同一个"改密码"动作，在两种场景下的安全语义完全相反**：

- 本人改自己的密码 → **Key 必须保留**
- 管理员重置他人的密码 → **Key 必须销毁**

如果只实现一个接口，无论选哪种语义都是错的：要么本人改个密码把 Key 全废了（体验灾难），要么管理员能重置后登录读 Key（隔离失效）。

#### 判定依据：操作者是否等于目标用户

**不是看角色，是看"操作者是不是本人"。** 这条很关键——`superadmin` 改自己的密码也走路径 A，不能被"管理员"这个身份误伤。

| | 路径 A：本人改密码 | 路径 B：管理员重置 | 路径 C：忘记密码 |
|---|---|---|---|
| 触发者 | 本人 | 管理员 | 本人（无法证明身份） |
| 是否校验旧密码 | **必须** | 不校验（也没有旧密码） | 不校验 |
| `wrappedDek` | 重新包裹，**保留** | **置 null，销毁** | **置 null，销毁** |
| 该用户已有 Key | **完全不受影响** | 全部 `enabled=false` | 全部 `enabled=false` |
| 用户是否需要重新录入 | 不需要 | 需要 | 需要 |
| 审计 action | `user.password_change` | `user.password_reset` | `user.password_reset`（self） |

#### 路径 A：重包裹（Re-wrap），Key 不动

前提是操作者能提供旧密码，因此能先解出 DEK：

```
1. 校验旧密码 → 用旧密码 + keySalt 派生旧 KEK → 解开 wrappedDek 得到 DEK
2. 用新密码派生新 KEK
3. 用新 KEK 包裹同一个 DEK → newWrappedDek
4. 单事务内写入：passwordHash = 新哈希, wrappedDek = newWrappedDek
5. 清空该用户所有会话（迫使其他设备重新登录）
```

要点：

- **`apiKeyEnc` 一个字节都不变**，所以 Key 不受影响，用户无感。
- **`keySalt` 默认不换**。KEK 由「密码 + salt」决定，密码变了 KEK 自然就变了，换 salt 没有额外收益，只会让需要原子写入的字段变多、失败面变大。若要更彻底，可另做「轮换全部密钥材料」的高级动作（同时换 salt 与 DEK，重新加密所有 Key），默认关闭。
- **必须是一个事务**。如果 `passwordHash` 写成功、`wrappedDek` 写失败，用户下次用新密码登录会解不开 DEK，Key 全部报废——这是最难排查的数据损坏。任何一步失败必须整体回滚。
- 改密码前若会话处于未解锁状态，先弹出旧密码输入框完成解锁，再做重包裹。

#### 路径 B：重置（Destroy），Key 报废

管理员手里没有旧密码，技术上**不可能**保留 Key——DEK 解不开，保留密文也没有意义。所以重置必然等于销毁：

1. `wrappedDek = null`
2. `dekVersion + 1`
3. 该用户所有 `Credential.enabled = false`，`lastError = "密码已重置，密钥需重新录入"`
4. 写审计 `user.password_reset`

界面必须红字提示「该用户的所有 API Key 将永久失效，需要重新录入」，并二次输入目标用户名确认。

#### 关于路径 C：忘记密码

容易被漏掉的一条。用户忘了密码走"忘记密码"流程时，**本质上无法证明自己是账号所有者**，所以必须按路径 B 处理，Key 报废。文档里不能把它写成"改密码"的变体，否则实现时很容易复用 re-wrap 逻辑而报错。

#### 设计意图

分开两条路径的意义不只是体验，而是**把"密钥销毁"能力变成只有管理员才能触发的动作，且必定留痕**。同时本人改密码不需要付出任何代价——这样用户才有动力定期改密码。

反过来，如果为了省事做成一条路径：允许管理员"改密码但不销毁"，就等于给了部署者一条读取任意 Key 的合法通道，第 1 节的承诺立刻作废。

### 5.2 查询隔离不能靠"先查后过滤"

反例（很常见）：

```ts
const all = await prisma.credential.findMany();
return all.filter(c => c.ownerUserId === user.id);  // 已经全部读进内存了
```

正确做法是在**类型层面**就把路堵死：

```ts
// 只有这一个查询入口，签名强制带 userId
class CredentialRepository {
  findForUser(userId: string, id: string) { ... }        // where: { id, ownerUserId: userId }
  listForUser(userId: string) { ... }
  // 没有 findById / findMany，管理端只能拿到 DTO
  listMetaForAdmin(): Promise<CredentialMetaDTO[]>       // 类型里不含 apiKeyEnc
}
```

再配合返回类型：

```ts
type CredentialPublicDTO = {
  id: string; label: string; provider: string;
  keyMasked: string;   // sk-****a1b2
  // 没有 apiKeyEnc，没有 apiKey
};
```

前端拿不到、后端类型里没有、数据库查询条件里带着——三层都在防，任何一层被绕过还有其他两层。

### 5.3 解密函数必须收窄调用面

```ts
// 唯一能解密 Key 的地方，且必须显式传入运行时 DEK
function decryptApiKey(enc: string, dek: Buffer): string
```

- `kill` 掉所有"从数据库自己取 DEK"的封装；
- 调用方只有 `ModelGateway.dispatch()` 一处；
- DEK 只能从 `RuntimeKeyStore.get(sessionId)` 取，取不到就抛 `KeyLockedError`，不允许降级到任何默认值。

代码评审时搜 `decryptApiKey` 的引用数，多于 1 个就要问为什么。

---

## 6. 审计：让"偷偷动了什么"留痕

`AuditLog` 只增不改不删，且用哈希链防篡改：

```
hash = sha256(prevHash + actorUserId + action + target + createdAt + payloadDigest)
```

- 应用层不注册任何 UPDATE / DELETE 的仓储方法；
- 数据库账号不授予 DELETE 权限（部署者如果绕过应用直接改库，会导致后续所有 `hash` 校验失败）；
- 后台提供"校验完整性"按钮，从最早一条重算到最新，报告断点在第几条。

必须记录的动作：

| action | 说明 |
|---|---|
| `credential.create` / `.update` / `.delete` / `.rotate` | 变更，记录掩码不记录明文 |
| `credential.disable_by_admin` | 管理员紧急停用（唯一能碰他人 Key 的操作） |
| `credential.unlock` | **DEK 解锁事件**，这是最关键的一条：谁在什么时候解开过自己的密钥库 |
| `user.password_change` | 本人改密码（重包裹 DEK，Key 保留） |
| `user.password_reset` | 管理员重置他人密码（销毁 wrappedDek，Key 报废） |
| `user.password_reset_self` | 本人走忘记密码流程（同样销毁） |
| `user.create` | 建号（首次启动种子 / 用户管理），记录用户名与角色，不记录密码 |
| `admin.impersonate`（如果实现） | 管理员以他人身份操作，必须留痕 |

`credential.unlock` 这条日志的价值：如果哪天怀疑 Key 泄露，它能告诉你哪些时间窗口内明文存在于内存中。

---

## 7. 侧信道与残留

| 面 | 处理 |
|---|---|
| 接口报错 | Key 无效只返回「密钥无效或余额不足」，**不回显任何片段**，不区分 401 和 403 的文案 |
| 列表页 | 只显示 `keyMasked`（末 4 位）；新建后**只显示一次完整 Key 的确认提示**，且不可复制 |
| 日志 | 白名单字段脱敏。`apiKey`、`authorization`、`dek`、`wrappedDek` 根本不在白名单里，不会被序列化输出 |
| 异常堆栈 | 生产环境关闭 error 详情外发，只在服务端落盘（且已脱敏） |
| 用量数据 | superadmin 只看全站聚合；单 Key 的消耗只对 owner 可见（消耗曲线可以反推 Key 是否有效） |
| 备份 | 备份文件是密文，安全；但备份里含 `wrappedDek`，所以要提醒：**备份泄露 + 用户密码泄露 = Key 泄露** |
| 内存 | 不防御。见第 1 节 |

---

## 8. 落地检查清单

实现时逐条打勾，缺一条就算没做完：

- [ ] 权限枚举中不存在 `credential.read.plaintext` 及任何等价 action
- [ ] `CredentialRepository` 无 `findById` / `findMany`，只有带 `userId` 的方法
- [ ] 所有对外 DTO 类型中不含 `apiKeyEnc` 字段（靠 TypeScript 编译期保证）
- [ ] `decryptApiKey` 全局只有 1 处调用
- [x] `change-password` 与 `reset-password` 是两个独立接口，前者强制校验旧密码
- [x] `change-password` 在**单事务**内同时更新 `passwordHash` 与 `wrappedDek`，任一失败整体回滚（CAS 单条 SQL）
- [x] `change-password` 不修改任何 `Credential` 记录（Key 必须原样保留）
- [x] `reset-password` 不校验旧密码，且必须销毁 `wrappedDek` 并停用该用户全部 Credential
- [x] 「是否销毁」的判定依据是 **操作者 ≠ 目标用户**，而不是操作者是否为 superadmin
- [x] 忘记密码流程复用 `reset-password` 的销毁语义，不复用重包裹逻辑
- [x] 审计 action 区分 `password_change` / `password_reset` / `password_reset_self`
- [x] 启动自检：扫描 `Credential.apiKeyEnc`，发现非 `dek:v1:` 前缀则拒绝启动并提示迁移
- [x] 日志中间件白名单中不含任何密钥字段（`AppExceptionFilter` 只记 method / path / code，**不记 body 与 headers**）
- [x] 审计哈希链校验接口可用，且能报出断点（`POST /api/admin/audit/verify`）
- [ ] 未解锁时机器人走预设话术 + 通知 owner，而不是静默不回

> **2026-10-23 进度**：除 1/2/3/4 与最后一条外全部打勾。
> 1–4 依赖凭据模块（第 5 步），最后一条依赖 M2 的消息链路。
> 认证链路已有 50 个单测 + 真实库冒烟 + 14 项 HTTP 冒烟三重复核。
> 第 7 条尤其重要：它防止"开发期用全局 KEK 存了几条数据，上线后忘了迁移"这类事故。宁可启动失败，也不要带着两种解密路径上线。

---

## 9. 与现有设计的关系

- `Credential.apiKeyEnc` 的加密主体从"全局 KEK"改为"owner 的 DEK"，密文前缀 `enc:v1:` → `dek:v1:`
- `Credential` 增加 `ownerUserId`，所有查询强制带上
- `BotInstance.accessTokenEnc`、`appSecretEnc` 同样改为 owner DEK 加密（NapCat 的 token 泄露同样等于交出机器人）
- 新增 `User` 表承载 `keySalt` / `wrappedDek` / `dekVersion`
- `AuditLog` 增加 `actorUserId` / `targetOwnerId` / `ip` / `prevHash` / `hash`
- 新增运行时组件 `RuntimeKeyStore`（内存，不持久化）

这些改动已落到 `prisma/schema.prisma`，字段注释里写明了约束原因。
