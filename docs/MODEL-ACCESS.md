# 模型接入模块（Model Access）

> 配套 `ARCHITECTURE.md`。这个模块是整个后台的**供能层**：所有 AI 能力都从这里出去。
> 设计前提：**我们不构建智能体**，只做"密钥托管 + 调用 + 计量"。

---

## 1. 职责边界

| 做 | 不做 |
|---|---|
| 存用户提供的 API Key（DeepSeek / OpenAI / 通义 …），加密落库 | 自研 Agent 运行时、工具调用、多步规划 |
| 配 Provider、baseURL、鉴权方式、模型、参数 | 训练、微调模型 |
| 统一调用入口：路由、超时、重试、降级、流式 | 自建 RAG / 向量库（第一版） |
| 拉取可用模型列表、连通性测试 | Prompt 自动优化 |
| 计量 token、算成本、预算熔断 | 做多模型投票、反思链等复杂编排 |

一句话：**它是一条"把 messages 发出去、把 text 拿回来"的管道，外面包了密钥管理和账本。** 它不含任何业务含义，不认识"人设"，也不知道 QQ 的存在。

---

## 2. 三个核心概念

```
Provider      预设的厂商模板（协议 + 默认地址 + 鉴权方式 + 推荐模型）
   ↓
Credential    一条具体的 Key（加密存储、可多条同 Provider、带预算与优先级）
   ↓
ModelRoute    某个 QQ 实例用哪条 Credential 的哪个模型（主 / 备 / 轻量）
```

分开的原因：换 Key 不动业务配置；一个实例可以主模型用 A 家的、轻量任务用 B 家的；同一家厂商可以有多条 Key 做轮换。

---

## 3. Provider 预设

大部分国内厂商都提供 OpenAI 兼容接口，所以真正的实现只有 **3 个协议适配器**：

| 适配器 | 覆盖 |
|---|---|
| `openai-compatible` | DeepSeek、OpenAI、通义、智谱、Kimi、硅基流动、火山方舟、Ollama、各类中转站 |
| `anthropic` | Claude（`x-api-key` + `anthropic-version`） |
| `gemini` | Google Gemini（`?key=` 查询参数） |

预设表（`baseUrl` 以官方文档为准，界面允许覆盖）：

| key | 名称 | 默认 baseUrl | 鉴权 | 典型模型 |
|---|---|---|---|---|
| `deepseek` | DeepSeek | `https://api.deepseek.com/v1` | Bearer | `deepseek-chat`、`deepseek-reasoner` |
| `openai` | OpenAI | `https://api.openai.com/v1` | Bearer | `gpt-4o`、`gpt-4o-mini` |
| `dashscope` | 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Bearer | `qwen-plus`、`qwen-max` |
| `zhipu` | 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | Bearer | `glm-4-plus`、`glm-4-flash` |
| `moonshot` | 月之暗面 | `https://api.moonshot.cn/v1` | Bearer | `moonshot-v1-8k` |
| `siliconflow` | 硅基流动 | `https://api.siliconflow.cn/v1` | Bearer | 各家开源模型 |
| `volcengine` | 火山方舟 | `https://ark.cn-beijing.volces.com/api/v3` | Bearer | 豆包系列 |
| `anthropic` | Anthropic | `https://api.anthropic.com/v1` | `x-api-key` | `claude-sonnet-4` |
| `gemini` | Google | `https://generativelanguage.googleapis.com/v1beta` | query `key` | `gemini-2.5-pro` |
| `ollama` | 本地 Ollama | `http://127.0.0.1:11434/v1` | 无 | 本地已 pull 的模型 |
| `custom` | 自定义兼容 | 用户填 | Bearer | 任意中转 / 自建 |

新增厂商**不需要写代码**，填一张 preset 记录即可。这是"留扩展空间"在这个模块的体现。

---

## 4. 数据模型

`Credential` 表（见 `prisma/schema.prisma`），关键字段：

| 字段 | 作用 |
|---|---|
| `provider` | 预设 key |
| `label` | 后台展示名，如「我的 DeepSeek」 |
| `ownerLabel` | **来源标注**：这张 Key 是谁给的、什么用途。用户提供 Key 的场景靠它区分 |
| `baseUrl` | 留空走预设，支持中转站 |
| `authStyle` | `bearer` / `x-api-key` / `query` |
| `apiKeyEnc` | AES-256-GCM 密文，`enc:v1:` 前缀 |
| `keyMasked` | `sk-****a1b2`，界面只显示这个，**保存后不可回显** |
| `catalogJson` | `[{id, name, contextWindow, priceInPerM, priceOutPerM}]`，模型目录 + 单价 |
| `dailyBudgetCents` / `monthlyBudgetCents` | 0 表示不限 |
| `priority` | 同 Provider 多 Key 时，数字小的先用（轮换 / 降级） |
| `lastCheckedAt` / `lastCheckOk` / `lastError` | 健康状态，列表页直接标红 |

用量单独落 `ModelUsage`（每次调用一条：provider、model、tokenIn/Out、costCents、purpose、sessionId），这样看板和预算都从流水算，不依赖计数器。

---

## 5. 后台页面

### 5.1 密钥列表 `/settings/credentials`

| 列 | 说明 |
|---|---|
| 名称 / 来源 | label + ownerLabel |
| Provider | 带厂商标识 |
| Key | `sk-****a1b2` |
| 状态 | 可用 / 未验证 / 验证失败（悬停看 `lastError`） |
| 今日用量 | token + 估算金额 / 日预算，进度条 |
| 绑定实例 | 有几个 QQ 实例在用 |
| 操作 | 测试、编辑、轮换、停用、删除 |

### 5.2 新增密钥（向导式，5 步，不可跳步）

```
1. 选 Provider      → 卡片墙，选中后自动填 baseUrl / authStyle
2. 填 Key 与备注     → 来源标注 field 在这里
3. 拉取可用模型      → 调 /models 拿到列表，用户勾选要用的
4. 设默认模型与预算   → 日/月预算，超额动作
5. 测试连接          → 必须通过才能保存并绑定实例
```

**第 5 步是强制项**。配错 Key 上线才发现，是这个模块最常见的坑：机器人突然不说话了，查半天发现是 Key 余额为 0。所以规则是：`lastCheckOk !== true` 的 Key 不允许被实例引用。

### 5.3 模型路由 `/settings/routes`

一个实例配三个槽位：

| 槽位 | 用途 | 建议 |
|---|---|---|
| `modelMain` | 主对话 | DeepSeek-chat / qwen-plus 等性价比款 |
| `modelCheap` | 内心独白、摘要、记忆抽取 | 同家最便宜的模型 |
| `modelFallback` | 主模型失败时的备份 | 换一家，避免同家一起挂 |

每个槽位绑定 `credentialId + model`，并可设 `temperature` / `maxTokens` / 超时。

---

## 6. 一次调用的完整链路

```ts
// 业务侧只调这一行，完全不感知是哪家厂商
const reply = await gateway.chat({
  instanceId,
  purpose: 'chat',          // chat | think | reflection | summarize
  messages,                 // 已由 session 装配好
  stream: true,
});
```

Gateway 内部 8 步：

1. **取路由**：`ModelRoute(instanceId, purpose)` → 目标 credential + model
2. **预算检查**：读当日/当月用量，超限则按策略 `warn | throttle | stop`
3. **取密钥**：解密 `apiKeyEnc`（解密结果只在内存存活，绝不进日志）
4. **选适配器**：按 `provider.adaptor` 拿到 `openai-compatible | anthropic | gemini`
5. **组装请求**：鉴权头、baseUrl、超时、stream 参数
6. **发送**：`AbortController` 控制超时，流式逐块回调
7. **失败处理**：见第 7 节
8. **记账**：解析 `usage` → 写 `ModelUsage` → 更新凭据健康状态

---

## 7. 容错策略

| 情况 | 处理 |
|---|---|
| 连接超时 | 5s，重试 2 次 |
| 首 token 超时 | 15s，重试 1 次 |
| 429 限流 | 退避 1s / 3s 重试，最多 2 次，仍失败则换同 Provider 的下一张 Key |
| 5xx / 网络错误 | 重试 2 次，再失败走 fallback 模型 |
| 401 / 403 | **不重试**，立即标记 `lastCheckOk=false`，写 `InstanceEvent(level=error)`，推告警 |
| 402 / 余额不足 | 不重试，标记并告警，切换 fallback |
| 内容被厂商拒绝 | 不重试，把拒答原因交给规则引擎决定是否换话术重写 |
| 连续失败 5 次 | 熔断 5 分钟，期间直接返回兜底话术 |

降级顺序：`主模型 → 备用模型（同 Key）→ 同 Provider 其他 Key → 兜底话术`。**任何一环都不能让机器人卡住不回**，宁可选一句预设的"我这边有点问题，等下再说"。

---

## 8. 成本控制

- 每次调用即记账，`costCents = tokenIn × 单价In + tokenOut × 单价Out`，单价从 `catalogJson` 取，没填就记 0（只统计 token 不报错）
- 预算两级：日、月。调用**前**按估算预扣，调用**后**按实际修正，避免并发超支
- 超额动作三选一：`warn`（只告警）/ `throttle`（切到 modelCheap）/ `stop`（停服并告警）
- 到达 80% 预算主动推一条通知；静默时段只发站内不推外部

自用场景下这套东西的真实价值不是省钱，是**在深夜被扣爆之前告诉你**。

---

## 9. 安全

完整方案见 [`SECURITY.md`](./SECURITY.md)，这里只列与本模块直接相关的部分：

- **加密主体是「用户」而不是「服务器」**：每把 Key 用该用户私有的 DEK 加密（`dek:v1:` 前缀），DEK 由用户密码经 Argon2id 派生的 KEK 包裹后存库。服务端不保存任何能解开它的材料，**部署者也解不开**。
- 接口永不返回明文，`keyMasked` 在保存时生成并持久化；DTO 类型里不含密钥字段。
- 查询在 where 条件里就带 `ownerUserId`，不存在"先全查再过滤"的写法。
- 日志脱敏采用**白名单**（只允许多数字段），不是黑名单——防止新增字段时漏掉。
- 密钥的增删改、以及每次 **DEK 解锁**，全部写 `AuditLog`；审计表只增不改，哈希链防篡改。
- 轮换：新增一张 Key 设为更高优先级 → 观察一天 → 停用旧 Key，全程不改业务配置。
- **管理员重置用户密码 = 销毁该用户全部 Key**（`wrappedDek` 置空）。否则管理员可以重置密码后登录该账号读取密钥，整个隔离就失效了。界面必须红字提示并要求二次确认。

---

## 10. 接口清单

所有凭据接口都以当前登录用户的 `ownerUserId` 为过滤条件。`superadmin` 只能访问元数据聚合与紧急停用（`/api/admin/...`），**没有任何返回明文的端点**，导出功能也不存在。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/providers` | 预设列表（含字段定义，前端动态渲染表单） |
| GET | `/api/credentials` | 列表（含今日/本月用量聚合） |
| POST | `/api/credentials` | 新建（需带测试结果） |
| PATCH | `/api/credentials/:id` | 改备注、预算、优先级、启停 |
| POST | `/api/credentials/:id/test` | 连通性测试（发一条 1 token 的最小请求） |
| POST | `/api/credentials/:id/probe` | 拉取模型列表写入 catalog |
| POST | `/api/credentials/:id/rotate` | 轮换 Key（旧 Key 保留至确认） |
| DELETE | `/api/credentials/:id` | 有实例引用时禁止，只能停用 |
| GET | `/api/credentials/:id/usage?range=7d` | 用量曲线与调用明细 |
| GET / PUT | `/api/routes/:instanceId` | 主/备/轻量模型路由 |

---

## 11. 实施顺序

**第 0 步必须先做，否则后面全部返工**：`User` 表 + DEK 体系 + `RuntimeKeyStore`。密钥的存储方式决定了 Repository 的签名、DTO 的形状、以及 Gateway 的解密入口，这些一旦按"全局密钥"写出来，改起来就是全量重构。

1. `auth`：User 表、Argon2id 派生、wrappedDek、RuntimeKeyStore、解锁/锁定
2. `contracts/provider.ts` 定接口 → 写 `openai-compatible` 适配器（覆盖 80% 厂商）
3. Credential CRUD + DEK 加密 + 测试连接（此时后台已经可用）
4. Gateway（路由 + 超时 + 重试 + 记账），解密入口只此一处
5. `anthropic` / `gemini` 适配器（按需）
6. 预算与告警
7. 前端三个页面：密钥列表、新增向导、路由配置

第 3 步做完就能用 Postman 验证：存一张 DeepSeek Key，点测试，返回 `pong`。这是整个项目的第一个"通"的里程碑，比接 NapCat 还早。

界面上的验收标准：**换一个浏览器用 superadmin 登录，翻遍所有页面、抓所有接口，只能看到 `sk-****a1b2`。**
