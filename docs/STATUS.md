# 开发状态

> **这是唯一的进度真源。** 每次改动代码后必须更新本文件。
> 新会话接手时，直接从「下一步」开始，不要重新规划。

**最后更新**：2026-10-24
**当前阶段**：M1 骨架完成（接入层 + 实例管理 + 接入安全兜底），差 NapCat 真机联调；联调通过即进 M2 最小闭环

---

## 仓库

- 远程：`git@github.com:Honestman69/aamps.git`（网页：https://github.com/Honestman69/aamps）
- 分支：`main`，首个提交 `ceccdc6`
- **里程碑标签**（回档锚点，见 `AGENTS.md`「分支与合并纪律」）：
  - `m1-skeleton` —— M1 骨架完成（适配器 + 实例管理 + 接入安全兜底）
  - 合并一律 `git merge --no-ff`，分支保留不删；回档首选 `git revert -m 1 <merge>`
- 网络：本机 `github.com:22` 会被重置，`~/.ssh/config` 已配置走 `ssh.github.com:443` + `Compression yes`。
  直接 `git push` 即可；若出现 `Connection reset`，先重试一次，通常是网络波动。
- 包管理器：本机原本没有 pnpm，已用 `corepack enable pnpm`（9.15.0）装好；依赖已 `pnpm install`。
  `corepack pnpm install` 首次约 9 分钟，别以为卡死了。
- 构建：`pnpm build` 先构建 `packages/*`（契约包 `main` 指向 `dist/index.js`）再编译主服务。
  只跑 `tsc` 不构建包，运行时会 `ERR_MODULE_NOT_FOUND`。
- **推送状态**：2026-10-24 已恢复到 `9c933b9`（M1 合并提交），同时推送了
  分支 `feat/m1-adapter-and-instance` 与标签 `m1-skeleton`。GitHub 凭据已配置在 Git Credential Manager。
  之前的阻塞原因是缺凭据（非网络），详见提交 `1c8667c` 的说明。
  若以后又出现 `could not read Username`，先查 `git credential fill` 能不能返回用户名，不要先去折腾网络。

---

## 下一步（从这里开始写代码）

### ~~第 1 步：定契约（`packages/contracts/src/`）~~ ✅ 已完成

- [x] `message.ts` —— `InboundMessage` / `OutboundAction` / `Segment` / `PlatformEvent`
- [x] `platform.ts` —— `PlatformCapabilities`（平台能力声明）
- [x] `adapter.ts` —— `IAdapter`（platform / protocol / capabilities / 三类订阅）
- [x] `adapter-sdk.ts` —— **`AdapterManifest` / `IAdapterFactory` / `ConfigField`**（第三方适配器的开发接口）
- [x] `provider.ts` —— `ILLMProvider`（chat / 流式 / listModels）
- [x] `pipe.ts` —— `IPipe` + `DROP` 哨兵
- [x] `errors.ts` —— `KeyLockedError` / `ProviderError` / `RuleBlockedError`
- [x] `index.ts` —— 统一出口

> 契约已提升为独立包 `@newjob/contracts`，是主服务与所有适配器之间**唯一**的共享依赖。
> 改它等于改所有包，改动前先想清楚。

### ~~第 2 步：密码学底座（`src/common/crypto/`）~~ ✅ 已完成

- [x] `argon2.ts` —— `deriveKek(password, salt)`，参数 m=64MiB / t=3 / p=4 / hashLen=32
- [x] `envelope.ts` —— `wrapDek` / `unwrapDek` / `encryptWithDek` / `decryptWithDek`
- [x] `random.ts` —— `randomBytes` 的安全封装（DEK 32B、salt 16B、IV 12B）
- [x] 密文格式严格为 `dek:v1:<base64(iv)>:<base64(tag)>:<base64(cipher)>` 与 `wrap:v1:<base64(iv)>:<base64(tag)>:<base64(cipher)>`
- [x] `errors.ts` —— `DecryptionFailedError` / `SealedFormatError` / `LegacyCiphertextError`（错误信息不含密文片段）
- [x] `index.ts` —— 统一出口，业务代码只从这里取

**验收**：`pnpm test` 通过 13 个用例（加解密往返、错误密码解不开、篡改密文触发 GCM 校验失败、格式约束、AAD 绑定、Argon2 参数实际生效）。

**实现补充（后续不要改）**：

- 前缀 `dek:v1:` / `wrap:v1:` **同时作为 GCM 的 AAD**，所以 wrap 密文无法被当成 dek 密文解开（反之亦然）。这是"双解密路径"的第二道防线。
- `argon2.ts` 里 `Algorithm` / `Version` 只能写成数值常量（`2` / `1`）并加类型断言。`@node-rs/argon2` 把它俩声明成 `declare const enum`，**运行时是空对象**；写 `Algorithm.Argon2id` 会拿到 `undefined`，库悄悄回落默认值（m=19MiB / t=2），安全性被降级但代码看起来完全正常。已用 `parseOptions` 反查参数的用例锁住。
- 测试用 `vitest.config.ts` 配了 `@` 与 `@newjob/contracts` 别名，契约包直接指向源码（`packages/contracts/src/index.ts`），不要求先编译。
- **KDF 库用 `@node-rs/argon2`，不要换成 `argon2` 包。** 理由（2026-10-23 实测修正过，别按旧说法理解）：
  两个库在本机都能跑——`argon2` 0.45.1 自带 `prebuilds/win32-x64`，14 秒装完、Argon2id 出 32B 正常；
  但它是 `node-gyp-build` 找预编译包，遇到不匹配的平台/ABI 会回落到 node-gyp 现场编译（要 VS Build Tools + Python），
  而 `@node-rs/argon2` 是 napi 二进制、没有这条回退路径。**选后者是"永远不会进入编译分支"，不是"前者跑不起来"。**
  真要换（只有 `argon2.ts` 一个文件 + `parseOptions` 那条用例受影响），先问清楚再动。**已升级为决策，见 `DECISIONS.md` D014。**

### ~~第 3 步：认证与密钥库（`src/modules/auth/`）~~ ✅ 已完成

- [x] `runtime-key-store.ts` —— 内存 Map，`set/get/clear/clearForUser/touch/purgeExpired`，**不持久化**，`toJSON()` 只输出条目数
- [x] `password.service.ts` —— `changePassword`（重包裹，单事务 CAS）与 `resetPassword`（销毁）两条独立方法，外加 `resetPasswordSelf`（忘记密码）
- [x] `unlock.service.ts` —— 登录/解锁时解出 DEK；首次登录才生成 DEK；密码对但解不开时**不覆盖**
- [x] `audit.service.ts` —— 哈希链、`verifyTenant` 断点校验、payload 兜底裁剪
- [x] `ports.ts` —— Repository 接口（CAS 语义写进签名）
- [x] `dek-guard.ts` —— 解 wrappedDek 的三种失败统一映射（损坏 / 格式非法 / 旧格式）
- [x] `startup-check.ts` —— 扫描密文前缀，发现 `enc:v1:` 直接拒绝启动（SECURITY.md 第 8 条第 12 条）
- [x] `bootstrap.service.ts` —— 首次启动建 superadmin（幂等，不改已有账号密码）
- [x] `repositories/prisma-*.ts` —— Prisma 实现（CAS 用 `updateMany` + where 带旧值，一条 SQL 完成）
- [x] Prisma 首次迁移 `20261023145901_init` 已应用，`data/dev.db` 已建
- [x] `scripts/auth-smoke.ts` —— 真实 SQLite 端到端冒烟

**验收**：

- `pnpm test` **50 个用例全绿**（crypto 13 + auth 37）
- `pnpm typecheck` 全绿（主服务 + contracts + adapter-qq）
- `scripts/auth-smoke.ts` 在独立 `smoke.db` 上跑通：建号 → 首次解锁生成 DEK → 本人改密后**原 Key 仍可解密** → 管理员重置后**旧 Key 解不开** → 审计链完整 → 旧格式密文触发启动失败
- 跑法：`DATABASE_URL="file:../data/smoke.db" npx prisma migrate deploy` 然后 `DATABASE_URL="file:../data/smoke.db" npx tsx scripts/auth-smoke.ts`。**别指向 dev.db**，脚本会真的写数据。

**实现补充（后续不要改）**：

- **CAS 必须用一条 SQL**：`updateMany({ where: { id, passwordHash, wrappedDek } })`，不要"先读再判断再写"。两个并发改密请求之间只要有空隙，就会出现"哈希写成新的、wrappedDek 还是旧的"这种最难排查的损坏。
- **`dekVersion` 只在重置时 +1**。改密是"换 KEK 重包裹同一把 DEK"，DEK 本身没换代，版本号不该动。
- **审计 `createdAt` 在进程内严格递增**（同一毫秒顺延 1ms），且**下限取自数据库最后一条**，不只看内存字段。否则按时间重算链时同毫秒记录的顺序会退化成按 cuid 排序，一条没被改过的链会被误报断链；重启 + 时钟回拨时同样会误报。跨进程仍需数据库序列，当前单进程 + SQLite（D010）。
- **审计 payload 裁剪按字段名精确判定 + 值形态兜底**，不能用 `/(dek|key|token)/` 这类宽正则——曾经把 `dekVersion`、`wrapDekDestroyed` 也抹了，审计当场失去意义。

### ~~第 4 步：HTTP 层与启动装配~~ ✅ 已完成

- [x] `src/main.ts` —— 启动顺序：连库 → 密文前缀自检 → 种子管理员 → 才监听端口
- [x] `app.module.ts` —— `ConfigModule` + 全局 `PrismaModule` + `AuthModule`
- [x] `AuthModule` —— `RuntimeKeyStore` / `SessionService` 注册为**单例**，全部 `useFactory` + 显式 `inject`
- [x] 接口：`login`（登录即解锁）、`unlock`、`lock`、`me`、`POST /api/auth/password`
- [x] 管理端：`GET /api/admin/users`（脱敏 DTO）、`POST /api/admin/users/:id/reset-password`（二次确认用户名）、`GET /api/admin/audit`、`POST /api/admin/audit/verify`
- [x] `SessionService` —— 内存会话 + HMAC 签名 cookie，HttpOnly / SameSite=Lax，生产加 Secure
- [x] `SessionGuard` + `@CurrentSession()`
- [x] `AppExceptionFilter` —— `AppError` → 状态码 + `code`；非预期异常一律 500「内部错误」，只记 method/path/code（**不记 body**）
- [x] `scripts/http-smoke.ts` —— 对运行中的服务发真实请求的 14 项检查

**验收**：`scripts/http-smoke.ts` 全部通过（对照真服务、真 SQLite）：

- 未登录 401；错误密码与不存在用户**文案一致**（防枚举）
- 登录下发 HttpOnly cookie，cookie 里不含任何密钥材料
- 改密后当前会话仍可用，旧密码立刻失效，新密码可重新解锁
- `GET /api/admin/users` 不含 `wrappedDek` / `keySalt` / `passwordHash` / `apiKeyEnc`
- 重置自己 403；二次确认用户名不匹配 403
- 审计列表动作齐全且不含密码/密文；`audit/verify` 返回 `ok: true`
- 锁定后会话失效；伪造 cookie 401（签名校验生效）
- **每个响应体都断言过不含 `sk-` 明文与 `dek:v1:` / `wrap:v1:` 密文**

**实现补充（后续不要改）**：

- **会话不带 JWT**：cookie 里只有 `sessionId.hmac`。会话状态在服务端内存，撤销（改密/重置/锁定）能立即生效；代价是进程重启要重新登录（与 D005 一致）。
- **`BOOTSTRAP_ADMIN_PASSWORD` 只在建号时用一次**，账号已存在就跳过。不要改成"配置里改密码就生效"，那是后门。
- **启动顺序不能调换**：先自检再监听。反过来会让一个有问题的实例先对外服务几百毫秒。
- `resetPasswordSelf`（忘记密码）**没有挂 HTTP 路由**，只到服务层。它是"无法证明身份"的路径，挂成未认证接口等于账号接管入口。
- 构建：`pnpm build` 会**先构建 `packages/*`，再编译主服务**。契约包 `main` 指向 `dist/index.js`，所以直接 `tsc` 主服务而不构建包，运行时会 `ERR_MODULE_NOT_FOUND`。

### ~~第 5 步：凭据管理 + 零知识验收（M0 收尾）~~ ✅ 已完成

- [x] `CredentialRepository`：只有 `createForUser` / `listForUser` / `findForUser(userId, id)` / `updateForUser` / `deleteForUser` / `countForUser`，**没有 `findById` / `findMany`**
- [x] `CredentialService`：新增时用 owner 的 DEK 加密、只存 `keyMasked`，**模块内没有任何解密函数**
- [x] 接口：`GET/POST /api/credentials`、`PATCH/DELETE /api/credentials/:id`
- [x] DTO 收窄：类型里没有 `apiKeyEnc`，列表只返回 `keyMasked`（`sk-****a1b2`）
- [x] 零知识验收：superadmin 抓遍所有接口 + 直查数据库，只看得到掩码

**验收**：

- `pnpm test` **67 个用例全绿**（crypto 13 + auth 38 + credential 16）
- `pnpm typecheck` 全绿
- `scripts/http-smoke.ts` **23 项检查**全过（新增 8 项凭据检查 + 锁定后 401）
- `scripts/zero-knowledge-check.ts` 通过：15 张表、124 个字符串值全扫一遍，明文命中 0
- `docs/SECURITY.md` 第 8 节第 1/2/3/4 条已打勾

**实现补充（后续不要改）**：

- **归属隔离是 Index 级下推，不是内存过滤**：`findForUser` 的 `where` 是 `{ id, ownerUserId }`，`updateForUser` 用 Prisma 的扩展 `where`（唯一键 + 过滤条件）一条 SQL 完成，`P2025` 统一转成 `null`。别改成"先查再判断再写"。
- **`PUBLIC_SELECT` 是白名单**，`apiKeyEnc` / `tenantId` / `ownerUserId` / `catalogJson` 都不在里面。仓储层拿不到密文，上层就没有漏的可能。
- **凭据模块刻意不 import `decryptWithDek`**。M2 写 `ModelGateway` 时才会出现唯一的解密调用点，届时回来把 SECURITY 第 8 节第 4 条改成"1 处"。
- **请求体用 `.strict()`**：客户端传 `apiKeyEnc` / `ownerUserId` 直接 400，而不是静默忽略。静默忽略会让人以为设置生效了。
- **删除是物理删除**（D015），与「软删除优先」的例外关系已写进 `CONVENTIONS.md`。`enabled=false` 仍是"临时停用"，两条路径不要合并。
- **轮换 Key 记 `credential.rotate`**，只改元数据记 `credential.update`；两者在审计里必须能分开，否则出事时看不出"Key 到底换没换"。
- `list` 在未解锁时**也能用**（只返回掩码），`create` / `update(带 apiKey)` 必须先解锁 —— 没有 DEK 就没法加密，不存在"先存着"。

### ~~第 6 步：M1 骨架（AdapterRegistry + QQ 适配器）~~ ✅ 已完成（待真机联调）

- [x] `AdapterRegistry`：显式注册 `@newjob/adapter-qq` 的 factory，按 `manifest.protocol` 路由（键是 `platform:protocol`）
- [x] `packages/adapter-qq`：OneBot 11 WS 连接（`connect` 只试一次 + 断线指数退避重连 + `get_status` 心跳探活）
- [x] 事件转换：OneBot 原始事件 → `InboundMessage`（**不填 `raw`**，CQ 码字符串不解析）
- [x] 收到消息 → 回 `pong`（带引用回复）
- [x] 发送节流（令牌桶，参数取自 `capabilities.rateLimitHint`）
- [x] 实例模块：QQ 号 / WS 地址 / token 全部存在 `BotInstance` 里，**没有任何写死的号或地址**
- [x] 实例接口：`GET/POST /api/instances`、`PATCH/DELETE /api/instances/:id`、`POST /api/instances/:id/connect|disconnect`
- [x] `GET /api/adapters`：返回 manifest，前端据此渲染配置表单
- [x] 接入地址护栏：默认只允许回环/私网，公网需 `ALLOW_REMOTE_ADAPTER=true`
- [x] 连接后核验登录账号（`get_login_info`）与账号在线（`get_status`）
- [x] NapCat 数据目录的提交闸门：`pnpm check:local-data`

**验收**：

- `pnpm test` **112 个用例全绿**（crypto 13 + auth 38 + credential 16 + instance 20 + adapter 21 + registry 4）
- `pnpm typecheck` 全绿（主服务 + contracts + adapter-qq，测试文件也在内）
- `scripts/http-smoke.ts` **31 项检查**全过（新增 8 项实例检查：配置表单可读、QQ 号接口可填、token 不回显、NapCat 未启动时 502 且状态回落、公网地址 400 拦截）
- `test/adapter-qq/onebot-e2e.test.ts`：**真的起一个 OneBot WS 服务端**，验证鉴权参数、事件转换、`pong` 回发、断线自动重连

**实现补充（后续不要改）**：

- **配置三个来源，别搞混**：QQ 号 / WS 地址 / token 存 `BotInstance`（数据库）；`SESSION_SECRET` 这类进程密钥存 `.env`；适配器只从 `AdapterDeps.config` 拿，**不读环境变量**。换号 = 新建一条记录，换服务器 = 改一条记录的 endpoint。
- **连接必须先解锁**：token 用 owner 的 DEK 加密（与 API Key 同一套），而 DEK 只在解锁后存在于内存（D005）。所以**进程重启后实例不会自己上线**，要等用户登录后点连接。这是设计代价，不是 bug（见 D016）。
- **`connect()` 只尝试一次**，失败立刻报 502。自动重连只发生在"已连上之后的意外断开"，避免后台点一次连接就陷入无限重试。
- **重连退避**：1s 起、每次翻倍、上限 30s、连续 10 次放弃并落 error 日志。放弃后需要人再点一次连接——风控考虑，不想让一个掉线的号无限敲门。
- **心跳是自己发 `get_status`**，不是等 NapCat 的 heartbeat。等对方的探活无法区分"对方挂了"和"对方不发心跳"。
- **`message_sent` 一律丢弃**：否则机器人会把自己的回复当新消息，自问自答。
- **原始结构不出包**：`InboundMessage.raw` 刻意不填。填了之后下游总有人读 `post_type`，铁律当天破。
- **发送节流在适配器内部**，不是上层。多实例各自一个桶，不共享——共享会让一个号被限速拖累所有号。
- **接入地址默认拒绝公网**（`endpoint-guard.ts`）：回环 / RFC1918 / 链路本地 / Tailscale 的 100.64/10 / 单标签主机名 / `.local` 放行，其余返回 `REMOTE_ENDPOINT_BLOCKED`。理由不是洁癖：指向别人的 NapCat 等于把 QQ 登录态交给对方。开关只认 `true`/`1`，写错字不会意外打开。**create / update / connect 三处都校验**，因为开关可能事后被关掉。
- **连接成功 ≠ 登对了号**：`connect()` 之后必须 `get_login_info` 核对 `user_id === selfId`，不一致就断开并报错（错误信息里是掩码）。再加 `get_status` 判 `online`，`good === false` 只告警不阻断（表示接收链路不健康，消息可能不来）。
  > 这条是对比 `D:\Projects\QQ-bot` 之后补的：那边明确记过「WS 通、进程活、控制台全绿，但 hook stale 导致群里一条消息都不来」，而且 `get_login_info` 拿不到健康度，必须用 `get_status`。
- **连接失败必须真的 close**：早期版本在 `verifyLogin` 抛错时只把 `this.client = null`，socket 还开着，NapCat 侧会认为连接有效。现在 catch 里先 `client.close()` 再置空，测试里用 `openSockets === 0` 断言。
- **NapCat 数据目录的闸门**：`.gitignore` 覆盖 `napcat/`、`napcat-data/`、`.config/QQ/`、`onebot_*.json`、`ntqq_*.json`；`pnpm check:local-data` 同时扫「已跟踪」与「未被忽略」两类文件（前者是已经出事了，后者是下次 `git add -A` 就出事），命中即非零退出。已用 `git add -f` 实际验证过它能拦住。

### 第 7 步：NapCat 真机联调 ← 现在做这个

代码层面 M1 已通，差一次真实环境验证。前置：装 NapCat、准备小号（`STATUS.md` 未决问题 1、2 已定：先本机、后云）。

**2026-10-24 联调结果**：环境就绪，`pong` 闭环跑通；随后发现上游 token 缺陷并改为反向 WS。

| 项 | 结果 |
|---|---|
| NapCat / QQ | v4.18.41 / 9.9.33-52230（绿色版在 `D:\napcat`，仓库外） |
| 登录 | 小号 **3194107669**；勾"记住设备"后 `-q` 快速登录，无需再扫码 |
| 接入配置 | `onebot11_<uin>.json` → 反向 `ws://127.0.0.1:3002`（正向 3001 已停用）；`webui.json` → `127.0.0.1:6099` |
| aamps 连接 | 建实例 → `connect` 返回 `online` → 发消息收到 `pong` ✅ |
| 账号核验 | `get_login_info` 与实例配置一致（不一致会被拒） |
| **token 鉴权** | 反向模式：错 token 握手 HTTP 401，正确 token 连入 `online`（真机验证 ✅） |

- [x] NapCat 配置接入方向（反向 WS，`ws://127.0.0.1:3002`）
- [x] 建实例：QQ 号 + 监听地址 + token → `POST /api/instances/:id/connect`（M4 前没有页面，
      用 `pnpm connect`）→ 日志出现 `adapter.listening` + `adapter.peer_connected`
- [x] 私聊发一条消息 → 收到引用回复 `pong`（正向模式真机 1 次；反向模式用对端脚本验过回包内容）
- [ ] 群里 `@机器人` 一条 → 应收到 `pong`；不 @ 时不回复（`isMentioned` 生效）
- [x] 停掉对端 → 观察重连；对端恢复后自愈（反向模式下 NapCat 每 5 秒重试，实测 1~5 秒回到 `online`）
- [ ] 换小号测试"切换"：新建第二条实例、连上新的、断开旧的
- [ ] 故意填错 QQ 号 → 应被"账号不一致"拦住（验证 `get_login_info` 核验真的生效）
- [x] `pnpm check:local-data` 通过；确认 `napcat/` 没有被 git 看到
- [ ] 迁移演练：把 `napcat/` 目录复制到别处，确认**不搬数据**也能靠重新扫码跑起来
- [x] **WS token 鉴权（原阻塞项）**：改反向 WS 后由本服务在握手阶段校验，见 `SECURITY.md`

**2026-10-24 应用层验证**（走完整 HTTP 路径，不是只测适配器）：

```
POST /api/auth/login                → 200, unlocked=true
POST /api/instances/<id>/connect    → 200 {"status":"online"}（2.6 秒，NapCat 自己连入）
错误 token 连 3002                   → HTTP 401，日志 adapter.peer_rejected(token_mismatch)
正确 token + 推一条私聊              → 服务回 send_msg：[reply(778899), text("pong")]
对端断开                             → 5 秒内 NapCat 重连回来，status 回到 online
```

**验收**：除群里 @、换号切换两项外全过；日志里没有任何 token / 完整 QQ 号。

**已知缺陷（NapCat 4.18.41）**：`websocketServers` 的 `token` 校验不生效（已改反向绕开，见 D018）。

```
UD.createServer → this.authorize(this.config.token, ws, req)
authorize(e, n, r, i)   // HTTP 中间件签名，第 4 参是 next 回调
  → i 为 undefined → 三个分支都抛 TypeError → async 回调吞掉 → 连接保持打开
```

同文件里存在正确的 `authorizeWS(e, n, r)`，但 WebSocket 适配器没用它。
后果：本机任何进程都能连 `127.0.0.1:3001` 控制机器人，**唯一防线是端口绑定**。

**待定方案**：
- A 降级 NapCat 到校验正常的版本（要重新验证 QQ 版本兼容，下载慢）
- **B 改反向 WS（推荐）**：NapCat 作客户端连我们，token 由我们校验；附带好处是云端部署不用开入站端口
- C 接受现状：仅 `127.0.0.1` 防护，等上游修复

---

## 任务看板

### M0 安全底座

- [x] `User` 表迁移 + 种子数据（创建 superadmin）
- [x] Argon2id KEK 派生
- [x] DEK 生成 / 包裹 / 解包
- [x] `RuntimeKeyStore`（内存，不落盘）
- [x] 登录 → 解锁 → DEK 就位
- [x] 锁定 / 会话过期满 → DEK 清除
- [x] `changePassword`：单事务重包裹，Key 不变
- [x] `resetPassword`：销毁 wrappedDek + 停用全部 Credential
- [x] 审计日志 + 哈希链 + 完整性校验接口
- [x] 凭据管理：信封加密写入 + 掩码 + 4 个接口 + 审计（create / update / rotate / delete）
- [x] 零知识验收：用 superadmin 登录抓所有接口 + 直查全库，只看得到 `sk-****a1b2`

### M1 骨架

- [x] NestJS 工程初始化（Fastify adapter）
- [x] `.env` 加载与启动自检
- [x] Prisma 迁移跑通
- [x] **AdapterRegistry**：显式注册 `@newjob/adapter-qq` 的 factory，按 `manifest.protocol` 路由
- [x] `packages/adapter-qq`：OneBot 11 WS 连接（`connect` / 心跳 / 重连）
- [x] 事件转换：OneBot 原始事件 → `InboundMessage`（禁止把原始结构往上抛）
- [x] 收到消息 → 回 `pong`
- [x] 发送节流（全局令牌桶）

### M2 最小闭环

- [ ] AgentConfig / ConfigResolver（四级覆盖）
- [ ] `ModelGateway`：路由 + 超时 + 重试 + 记账
- [ ] `openai-compatible` Provider
- [ ] Persona 拼装 system prompt
- [ ] 私聊能正常对话

### M3 拟人

- [ ] 状态机（mood / energy / affinity）
- [ ] 发言决策器
- [ ] 双阶段生成（内心独白 → 外显）
- [ ] 表达层（拆条 / 打字延迟 / 表情 / **是否引用上一条**）
      —— 引用不是默认行为：真人只在这一句需要指回上文时才引用。M1 的占位回声曾经
      无条件引用（`replyToMessageId`），看着很机械，已去掉；协议层能力保留。
- [ ] 行为拟人（夜间静默 / 连续发送上限 / 相似内容拦截）

### M4 管理后台

> 目标：M1~M3 阶段**没有页面**，操作一律走 HTTP 接口（`scripts/connect-instance.ts` 是临时的连接入口）。

- [ ] Vue3 工程 + 登录页
- [ ] 人设编辑器
- [ ] 规则/约束词配置
- [ ] 密钥管理页 + 新增向导（强制测试连接）
- [ ] 会话查看

### M5 记忆与自主

- [ ] 工作记忆（最近 N 轮）
- [ ] 反思任务（每日摘要）
- [ ] 语义记忆（用户画像）
- [ ] 主动消息（默认关闭）

### M6 风控与观测

- [ ] 健康分 + 风控巡检
- [ ] 自动降级（只读 → 停实例）
- [ ] 看板与告警

---

## 已完成

- [x] 2026-10-23 需求调研（QQ 开放平台公告、拟人化互动服务管理办法、AI 标识办法）
- [x] 2026-10-23 架构设计 `docs/ARCHITECTURE.md`
- [x] 2026-10-23 数据模型 `prisma/schema.prisma`（14 模型，validate 通过）
- [x] 2026-10-23 模型接入设计 `docs/MODEL-ACCESS.md`
- [x] 2026-10-23 安全模型 `docs/SECURITY.md`（信封加密 + 权限矩阵）
- [x] 2026-10-23 决策记录 `docs/DECISIONS.md`
- [x] 2026-10-23 交接体系（`AGENTS.md` / 本文件 / `CONVENTIONS.md` / `README.md`）
- [x] 2026-10-23 工程骨架：`package.json` / `tsconfig` / `.env.example` / `.gitignore` / 目录结构
- [x] 2026-10-23 契约层 `packages/contracts/`（message / platform / adapter / adapter-sdk / provider / pipe / errors）
- [x] 2026-10-23 多平台扩展抽象（platform / protocol / capabilities 分离，见 D012）
- [x] 2026-10-23 **monorepo 改造**：契约提升为 `@newjob/contracts`，QQ 适配器独立为 `@newjob/adapter-qq`，依赖方向单向（见 D013）
- [x] 2026-10-23 适配器开发 SDK（`AdapterManifest` / `IAdapterFactory` / `ConfigField`，前端可据此动态渲染表单）
- [x] 2026-10-23 **密码学底座** `src/common/crypto/`（argon2 / envelope / random / errors + 13 个测试用例）
- [x] 2026-10-23 依赖安装与测试链路打通（`vitest.config.ts` 别名、`pnpm test` 可跑、`pnpm typecheck` 全绿）
- [x] 2026-10-23 **认证与密钥库** `src/modules/auth/`（RuntimeKeyStore / PasswordService / UnlockService / AuditService / Bootstrap + Prisma 仓储 + 启动自检）
- [x] 2026-10-23 **HTTP 层**：NestJS(Fastify) 启动装配、会话与签名 cookie、6 个认证/管理接口、全局异常过滤器、14 项 HTTP 冒烟
- [x] 2026-10-23 Prisma 首次迁移 `20261023145901_init`，`scripts/auth-smoke.ts` 真实库冒烟通过
- [x] 2026-10-24 **凭据管理** `src/modules/credential/`：仓储归属隔离（`ownerUserId` 下推 SQL）、加密写入 + 掩码、4 个接口、`.strict()` 入参、审计四动作
- [x] 2026-10-24 **零知识验收**：`scripts/zero-knowledge-check.ts` 全库 15 张表直查，明文命中 0；HTTP 冒烟扩到 23 项
- [x] 2026-10-24 **接入层**：`AdapterRegistry` + `adapter-qq` 完整实现（WS 连接/心跳/退避重连/令牌桶/事件转换/发送）
- [x] 2026-10-24 **实例管理**：QQ 号与 WS 地址存 `BotInstance` 并通过接口增删改启停，`pong` 闭环；101 个单测 + 30 项 HTTP 冒烟
- [x] 2026-10-24 **接入安全兜底**：endpoint 默认拒绝公网、连接后核验登录账号、NapCat 数据目录提交闸门（`pnpm check:local-data`）；112 个单测

---

## 未决问题

| # | 问题 | 影响 | 何时需要决定 |
|---|---|---|---|
| ~~1~~ | ~~NapCat 部署在哪（本机 / 服务器 / Docker）~~ → **已定**：先本机测试，确认后再迁云 | 结论：接入地址必须是**数据**（`BotInstance.endpoint`），不能是环境变量，否则换机器要改 `.env` 重启 | — |
| ~~2~~ | ~~用哪个 QQ 号做机器人（小号储备）~~ → **已定**：不写死，后台可增删/切换 | 结论：QQ 号存 `BotInstance.accountId`，一个号一条记录 | — |
| 3 | 是否需要语音消息（TTS / ASR） | 影响表达层与模型路由 | M3 |
| 4 | 人设是否要支持多套按时段切换 | 影响 Persona 与 Session 的绑定关系 | M4 |
| 5 | 是否需要群管理能力（欢迎、关键词） | 影响 Adapter 权限与风控 | M6 |

---

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-23 | 项目初始化：完成需求调研、架构、数据模型、模型接入、安全模型设计与交接文档 |
| 2026-10-23 | 完成密码学底座：Argon2id KEK 派生、DEK 信封加解密、AAD 绑定前缀、13 个测试用例；依赖已安装 |
| 2026-10-23 | 追加 D014：KDF 库固定 `@node-rs/argon2`（实测 `argon2` 亦可用，依据是"无编译回退路径"而非"跑不起来"）；并补「依赖类取舍写在哪」的判定标准 |
| 2026-10-23 | 完成 HTTP 层：登录即解锁、签名 cookie 会话、管理端重置/审计接口、启动自检接入；14 项 HTTP 冒烟通过 |
| 2026-10-23 | 完成认证与密钥库服务层：DEK 内存库、改密/重置双路径、解锁、审计哈希链、启动自检、Prisma 仓储、superadmin 种子；50 个单测 + 真实库冒烟通过 |
| 2026-10-24 | 完成凭据管理：加密写入 + 掩码 + 4 个接口 + 审计；67 个单测、23 项 HTTP 冒烟、零知识直查库全过；追加 D015（凭据物理删除） |
| 2026-10-24 | 完成接入层与实例管理：`adapter-qq`（WS/心跳/重连/节流/事件转换）、`AdapterRegistry`、实例 CRUD + 连接接口、`pong` 闭环；101 个单测、30 项 HTTP 冒烟；追加 D016（实例配置来源与解锁依赖） |
| 2026-10-24 | 补接入安全兜底：endpoint 护栏（`REMOTE_ENDPOINT_BLOCKED`）、`get_login_info` 账号核验、`check:local-data` 提交闸门；112 个单测；追加 D017（协议端地址与登录态边界） |
| 2026-10-24 | 建立分支纪律：M0 收尾与 M1 骨架分两次提交到 `feat/m1-adapter-and-instance`，合并前 typecheck / 112 单测 / build / 31 项冒烟 / 数据闸门全绿，`--no-ff` 合并并打标签 `m1-skeleton` |
