# 开发状态

> **这是唯一的进度真源。** 每次改动代码后必须更新本文件。
> 新会话接手时，直接从「下一步」开始，不要重新规划。
> **换机器 / 全新克隆先读 [`AGENTS.md`](../AGENTS.md) 的「换机器 / 全新克隆」**——
> 仓库里没有 `.env`、没有数据库，直接 `pnpm dev` 会失败。

**最后更新**：2026-10-25
**当前阶段**：**M4 进行中** —— 人设的增删改查/发布/归档/启用 API 已完成（第 24 步）；
前端工程（Vue3）尚未开始。M3 已完成并打标签 `m3-persona`。
M2 及之前全部完成（私聊能对话）。

**下一步（默认走这条）**：**M4-2 前端工程** —— `web/` 下 Vue3 + Vite + TS 脚手架，
先做三页：登录 → 实例设置（含 `modelVision` / `ttsCredentialId` / `ttsModel` / `imageHosts`）
→ 人设编辑器（消费第 24 步的 persona API）。
登录直接复用现有 cookie 会话（`POST /api/auth/login`），不引入新鉴权。

做完 M4-2 再补：密钥管理页、素材库管理页（`MediaAsset` 目前只能靠对话产生，没有后台入口）。

> **多模态要配三样才生效**（都在实例上）：`modelVision`（看图）、`ttsCredentialId` + `ttsModel`（发语音）。
> 不配就是"能力不存在"——图片只留「[图片]」占位，prompt 里也不提 `[voice]`。
> **素材库不需要配置**：平台支持发图即可用，模型说 `[save]名字[/save]` 就存，说 `[use]名字[/use]` 就发。

**M2 已完成的完整链路**（`PipelineService.handle`）：
入站消息 → 会话/消息落库 → 取 owner + 人设 + 配置（会话开关）→ 状态衰减 + 关系读取
→ `buildWindow`（D031）→ **attention 判定（M3，判掉就不花 token）** → 拼 system prompt（D020，含语气提示）
→ `ModelGateway.chat`（D024 预算 / D025 熔断 / 记账）→ `decideQuote`（D030）→ 出站 + 落库
→ 状态/关系回写。
失败走 `faultToSlot` + `decideSpeak` + `resolveFallback`（D028/D026），可能静默。

**另一条路（只在"准备上云"时才走）**：P0-2 部署拓扑选型（Tailscale 组网 vs 公网反代），
它决定一键接入包的 URL/证书策略；不做它也不影响本地开发。

---

## 仓库

- 远程：`git@github.com:Honestman69/aamps.git`（网页：https://github.com/Honestman69/aamps）
- 分支：`main`，首个提交 `ceccdc6`
- **里程碑标签**（回档锚点，见 `AGENTS.md`「分支与合并纪律」）：
  - `m1-skeleton` —— M1 骨架合并点（`9c933b9`，当时 token 鉴权还是坏的）
  - `m1-verified` —— M1 真机验收通过点（反向 WS + token 401 + pong，见「第 7 步」）
  - 合并一律 `git merge --no-ff`，分支保留不删；回档首选 `git revert -m 1 <merge>`
- 网络：本机 `github.com:22` 会被重置，`~/.ssh/config` 已配置走 `ssh.github.com:443` + `Compression yes`。
  直接 `git push` 即可；若出现 `Connection reset`，先重试一次，通常是网络波动。
- 包管理器：本机原本没有 pnpm，已用 `corepack enable pnpm`（9.15.0）装好；依赖已 `pnpm install`。
  `corepack pnpm install` 首次约 9 分钟，别以为卡死了。
- 构建：`pnpm build` 先构建 `packages/*`（契约包 `main` 指向 `dist/index.js`）再编译主服务。
  只跑 `tsc` 不构建包，运行时会 `ERR_MODULE_NOT_FOUND`。
- **推送状态**：2026-10-24 已推到 `20d0828`（D028 合并提交）。远端现有：
  `main` + 各阶段的 `feat/*` 分支（每个结构改造一条，合并后可留作追溯），
  `m1-skeleton`（`9c933b9`）与 `m1-verified`（`57d37ca`）两个标签。
  GitHub 凭据已配置在 Git Credential Manager；之前的阻塞是缺凭据（非网络），见提交 `1c8667c`。
  **push 失败的真正原因（2026-10-24 排查过）**：git 走 SSH，**规则 / PAC 模式的代理管不到 SSH**，
  只有「全局模式」或 TUN 才会接管。症状是 `Connection reset by 20.205.243.160 port 443`，
  而同一时刻 `curl https://api.github.com` 可能仍是 200——别被"网是通的"误导。
  处理办法：把代理切全局，一次就能推上去。**不要**去试 `https_proxy` 的各种组合
  （HTTP / SOCKS5 / 换 OpenSSL 后端都试过，全无效，纯属浪费）。
  另有一个坑：全局配置里有 `url.https://ghfast.top/https://github.com/.insteadOf`，
  会把所有 HTTPS 地址重写成镜像，而镜像只能拉不能推。真要走 HTTPS 就写
  `https://github.com:443/owner/repo`（带默认端口不匹配该前缀）。平时用 SSH 即可。
  若出现 `could not read Username`，先查 `git credential fill` 能不能返回用户名，不要先去折腾网络。
- **又一个 push 坑（2026-10-24 晚，HTTPS remote）**：报 `CONNECT tunnel failed, response 502`，
  但同一时刻 `curl -x $https_proxy https://github.com/...info/refs?service=git-upload-pack` 返回 **200**。
  原因：Windows 上 git 的 curl 后端（schannel）**不读 `https_proxy` 环境变量**，走的是系统代理设置，
  而系统代理那一路不通。解法是显式指定：
  ```bash
  git -c http.proxy="$https_proxy" push origin main   # 端口每次会变，直接读环境变量
  ```
  （端口换成实际的代理端口；要长期生效就 `git config http.proxy <url>`，但换网络后记得改回来。）
  **判断口径**：`curl` 通 + `git` 报 CONNECT/502 → 先怀疑"git 没用上同一个代理"，别去查凭据。

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

### ~~第 7 步：NapCat 真机联调~~ ✅ 已完成

代码层面 M1 已通，真机验证见下方「2026-10-24 应用层验证」。

**2026-10-24 联调结果**：环境就绪，`pong` 闭环跑通；随后发现上游 token 缺陷并改为反向 WS。

| 项 | 结果 |
|---|---|
| NapCat / QQ | v4.18.41 / 9.9.33-52230（绿色版在 `D:\napcat`，仓库外） |
| 登录 | 小号 `31****69`（完整号不进文档，见 `AGENTS.md` 硬性规则 6）；勾"记住设备"后 `-q` 快速登录，无需再扫码 |
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

**2026-10-24 合并前全量验证**（`AGENTS.md` 规定的四条 + 数据闸门，全绿才算可合并）：

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | 通过 |
| 单测 | `pnpm test` | **129 个全过**（新增反向 WS 16 个 + 仓储契约 3 个） |
| 构建 | `pnpm build` | contracts + adapter-qq + 主服务均出产物 |
| 端到端 | `scripts/http-smoke.ts`（独立库 `zk.db`、端口 3111） | `HTTP SMOKE PASSED`（26 项） |
| 数据闸门 | `pnpm check:local-data` | `PASSED`（141 个已跟踪文件） |

这轮端到端**抓到两个单测抓不到的问题**，都已修：

1. **`adapterMode` 漏透传**：`POST /api/instances` 传 `server`，实际落库是 `client`。
   `PrismaInstanceRepository.createForUser` 手写 `data: {...}` 时漏了这个字段，
   Prisma 静默用 DB 默认值（`client`）补上；单测用的是假仓储所以全绿。
   修法：把 `InstanceCreateInput.adapterMode` 改成**必填**（编译器强制所有创建路径显式给值），
   仓储忠实透传；补 `test/instance/prisma-instance.repository.test.ts` 断言"每个入参字段都出现"。
2. **冒烟用例语义漂移**：`实例：NapCat 没起来时连接 → 502` 在默认改成反向模式后，
   实际测的是"等对端 20 秒超时"而不是"拨号失败"。修法：该用例显式 `adapterMode: 'client'`；
   另加一条反向模式的失败用例（监听端口被占用 → 502 + offline）。

顺带修了 `scripts/http-smoke.ts` 顶部注释（写 `ADMIN_PASSWORD`，代码读 `SMOKE_PASSWORD`，照注释抄会踩空）。

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

### ~~第 8 步：人格归属定稿（D020 → D023 修订）~~ ✅ 已完成

**过程**（记录下来，避免以后再走一遍）：

1. 先按"跨平台共享"实现了一版：新增 `Agent` 表，人设/记忆/关系/情绪挂 `agentId`，实例自动挂默认 Agent。
2. 用户澄清边界：**本项目只保证"单个社交平台内"的演化**；换社交平台应重新生成初始人格、从零演化；
   跨社交平台演化另立项目。但**跨模型平台（Provider）必须继承**人格与记忆。
3. 按此**回退**：删掉 `Agent` 层，归属改回 `BotInstance`；D020 的归属段作废，新增 **D023** 记录边界。

**最终结构**：

- [x] 人格与记忆挂 `instanceId`：`Persona` / `MemoryItem` / `Relationship` / `AgentState`
- [x] `BotInstance.activePersonaId`（唯一）+ `Persona.archivedAt`（重置时归档旧版本）
- [x] `Relationship` 唯一键 `[instanceId, peerId]`（`userId` 正名 `peerId`，语义是"平台内用户"）
- [x] `BotInstance` 保留模型路由（`credentialId` / `modelMain` / `modelCheap` / `modelFallback`）
- [x] **人格表里没有任何 provider / credential / model 字段** —— 换 Provider 零迁移（D021/D023）
- [x] 迁移 `20261024121107_persona_scope_back_to_instance`（撤销 `add_agent_layer` 的结构）
- [x] 删除 `src/modules/agent/`，实例创建不再需要 Agent

**验收**：

- `pnpm test` **143 个用例全绿**；`pnpm typecheck` 全绿；`pnpm build` 三产物
- `pnpm check:local-data` PASSED（152 个已跟踪文件）
- `scripts/http-smoke.ts` `HTTP SMOKE PASSED`

**以后别再犯**：不要为了"将来可能跨平台共享"先加一层中间表。用户明确说了那是另一个项目的事，
多一层 join 会长期增加理解成本，而收益为零。

---

### ~~第 9 步：人格预算（D024）~~ ✅ 已完成

- [x] `BotInstance.dailyBudgetCents` / `monthlyBudgetCents`（分，`0` = 不限）+ `budgetPolicy`（`downgrade` / `block`）
- [x] **`Credential` 上的预算字段删除**（避免"预算挂哪儿"有两个真相）
- [x] 实例接口 `POST/PATCH` 接受预算字段；`GET` 返回；改预算不触发重连
- [x] 迁移 `20261024122824_budget_moves_to_instance`（含 `instance_budget` 两次结构变更）
- [x] 文档口径同步：`MODEL-ACCESS.md` 8.1（预算归属、单价来源、聚合维度）

**验收**：`pnpm test` **144 个用例全绿**（新增"预算挂人格、换 Key 不重置"）；`typecheck` / `build` / 数据闸门均通过。

**为什么挂人格不挂 Key**：换 Key（过期/换渠道/换厂商）在自用场景很常见，挂 Key 等于换一次刷一次额度，预算形同虚设。

---

### ~~第 10 步：余额可见 + 故障分级（D025）~~ ✅ 已完成

- [x] `Credential` 加余额字段：`balanceCents` / `balanceCurrency` / `balanceCheckedAt` / `balanceSource`
- [x] `Credential` 加熔断字段：`cooldownUntil` / `unavailableReason`（系统写，用户不可改）
- [x] 凭据 DTO 暴露 `balance`（三态）与 `health`（available / reason / cooldownUntil）
- [x] `src/modules/model/providers/presets.ts`：Provider 预设表，**余额接口用声明表达**
      （DeepSeek `/user/balance` 已核实；OpenAI/Anthropic/Gemini 老实标 `inferred`，不编接口）
- [x] `MODEL-ACCESS.md` 第 7 节重写：重试 / 熔断三层 / 兜底按故障时长分级 / 余额三态 / 通知去重
- [x] 迁移 `20261024125311_credential_balance_and_cooldown`
- [x] AGENTS 错题表补第 9 条（禁止所有失败回同一句话术）

**验收**：`pnpm test` **149 个用例全绿**（新增 5 个预设契约测试）；`typecheck` / `build` 通过。

**注意**：主动查询余额需要明文 Key（D005），所以**未解锁时只能显示上次快照并标注时间**；真正的
`refresh-balance` 接口与错误码识别放在 M2 的 `ModelGateway` 里实现。

---

### ~~第 11 步：兜底话术可配置（D026）~~ ✅ 已完成

- [x] `Persona.fallbacksJson`：`[槽位][渠道]` 两级；`null` = 不说，空串非法
- [x] `src/modules/persona/fallbacks.ts`：默认值 + 校验 + 容错解析 + 占位符渲染 + 序列化前校验
- [x] 校验规则：≤60 字、禁链接、禁运维词、仅 `{nickname}` / `{groupName}`
- [x] 容错：库里 JSON 坏了 / 值非法 → 回落默认值，**不抛异常**（人格数据坏了不能让机器人崩）
- [x] 迁移 `20261024130331_persona_fallbacks`
- [x] 文档：D026、`MODEL-ACCESS` 7.3 关联说明、AGENTS 错题表第 9 条

**验收**：`pnpm test` **164 个用例全绿**（新增 15 条话术规则用例）；`typecheck` / `build` 通过。

**为什么不让模型生成**：故障时模型恰好不可用，让它"编一句兜底"就是死循环。
兜底路径必须零依赖。编辑器属于 M4，M2 的 Pipeline 直接读这三个槽位就够了。

---

### 第 12 步：M2-1 配置解析 + 切换 Provider 的写路径 ← 已完成一半

**已完成的**：

- [x] `src/modules/config/`：`types` / `resolver`（纯函数）/ `config.service`（30s 超时缓存 + 写路径失效）
- [x] 覆盖链落地：租户默认（常量）→ 实例 → 人设（预留）→ 会话；每个字段带 `provenance`（这个值来自哪层）
- [x] 非法值处理：温度越界、限流 ≤0、空白模型名一律回落默认，**且来源保持 `default`**（表示"设了但被拒"）
- [x] 实例接口补齐 `credentialId` / `modelMain` / `modelCheap` / `modelFallback` / `modelTemperature`
- [x] **绑定凭据校验归属**（D027）：只能绑自己的 Key，错误文案合并"不存在/无权"
- [x] 只有接入参数变化才重连：改模型/温度/预算不再把连接踢掉
- [x] 写路径主动失效配置缓存（update / delete）

**还没做的**（M2 后续）：

- [x] `ModelGateway`：路由 + 超时 + 重试 + 记账（+ 错误分类与熔断） + 错误码识别（402 → `balance` 熔断）
- [x] `openai-compatible` Provider 适配器
- [x] Persona 拼装 system prompt（未决问题 6 已由 D030 定稿）
- [x] 私聊能正常对话（Pipeline 接 ConfigService + Gateway，第 18 步）

**验收**：`pnpm test` **185 个用例全绿**（新增 config 18 + 实例归属/缓存 3）；`typecheck` / `build` 通过。

**一个设计取舍**：人设层（Persona）当前不覆盖任何配置字段——行为参数属于 M3 表达层，
现在先保留分支与 provenance，等 M3 真正读取时再加字段，避免先造一堆没人消费的空壳。

---

### 第 13 步：M2-2 ModelGateway ✅（主体完成，预算与流式未接）

- [x] `gateway/classify.ts` —— 错误分类（纯函数）：`balance` / `auth` / `rate_limit` / `provider` / `network`，
      每种带"是否重试 + 冷却时长"
- [x] `providers/openai-compatible.ts` —— 手写 fetch（不引 SDK）：超时、外部 signal、usage 解析、
      错误带状态码与响应体抛给分类器
- [x] `gateway/gateway.service.ts` —— 选路（配置指定的 Key 优先 → 按 priority）→ 重试 → 熔断 → 记账
- [x] `metering/price.ts` —— token × **当次 Key 的目录价** → 分，向上取整；缺价记 0 并标记 `priced:false`
- [x] `gateway/repositories/prisma-gateway.repository.ts` —— 候选查询（跳过冷却、带 ownerUserId）+ 只写健康层
- [x] `ModelModule` 装配并注册到 `AppModule`

**验收**：`pnpm test` **202 个用例全绿**（新增 17 个 Gateway 用例，覆盖分类、计价、选路、熔断、重试、未解锁）；
`typecheck` / `build` 通过。

**一个必须记住的判定顺序**：`429` 既可能是限流也可能是欠费（OpenAI 欠费返回 429 +
`insufficient_quota`）。所以**先看响应体文案、再看状态码**；反过来会把欠费判成限流，
然后无限重试一个永远不会成功的请求。

**还没接的（下一步）**：

- [x] 预算检查：调用前按当日/当月用量判断 `downgrade` / `block`（第 15 步，D029）
- [ ] 402/欠费后的 `balanceSource='inferred'` 回写（**不做 owner 推送**，见 D028）
- [ ] 流式响应（M3 表达层需要逐字/分段）
- [ ] `anthropic` / `gemini` 协议适配（现在遇到会明确标 `unsupported_protocol` 并跳过，不假装能调）

---

### ~~第 14 步：故障 → 话术槽位映射（D028）~~ ✅ 已完成

- [x] `src/modules/persona/fault-slot.ts`：`faultToSlot(reason)`，7 种原因全覆盖（新增原因时编译期报错）
- [x] `FALLBACK_SPEAK_LIMITS`：`shortOutage` 1h/3 次、`longOutage` 6h/2 次、`budgetLimit` 12h/1 次
- [x] `decideSpeak(slot, { spokenAt, hasTemplate, now })`：先查日额度再查间隔；用户配 `null` → 必静默
- [x] 本地零点算"一天"（用 UTC 会让额度在凌晨 8 点重置）
- [x] **欠费不再需要通知模块**：D025 的 owner 推送与去重窗口取消（D028）

**验收**：`pnpm test` **214 个用例全绿**（新增 12 条：槽位映射、跨天重置、时钟漂移、用户 `null` 优先）。

**为什么必须先做这一步**：M2 接 Pipeline 时最省事的写法是 `if (reason === 'balance') 回话术`。
一旦这样写，限频、`null` 处理、槽位区分都会散落成 if 分支，之后改一次要翻遍代码。

---

### ~~第 15 步：预算拦截（D029）~~ ✅ 已完成

- [x] `metering/budget.ts`：`decideBudget` / `exceededLimit` / `usageRatio`，纯函数
- [x] 配置层补 `dailyBudgetCents` / `monthlyBudgetCents` / `budgetPolicy`（**只有实例层**）
- [x] `IGatewayRepository.usageTotals`：一次查询拿到今日/本月花费 + "未定价调用数"
- [x] 网关接入：读配置 → 解锁 → 预算 → 候选 → 调用（顺序有理由，见 D029）
- [x] `downgrade` 降无可降时按 `block` 处理（`cheap == main` / 已在用 cheap / cheap 为空）
- [x] 未定价调用打告警（一小时内去重），预算判定时说"用量偏低"
- [x] `GatewayFailedError` 的 reason 扩为 `GatewayFailureReason`，与 `fault-slot` 共用一份定义
- [x] `scripts/budget-smoke.ts`：真实 SQLite 验证聚合窗口、空库返回 0、拦截与降级

**验收**：`pnpm test` **240 个用例全绿**；`typecheck` / `build` 通过；
`budget-smoke` 五项全部通过（今日 40 / 本月 90，不含上月 300；达到上限即拒绝且不出网；降级后实际调用 cheap）。

**过程中抓到的真实缺口**：`presets.ts` 里**没有内置参考价**，所以新建 Key 若不填 `catalogJson`，
每次调用都会记 0 分，**预算永远不会触发**。已加告警与"未定价调用数"统计，并写进
`MODEL-ACCESS.md` 8.4 与 AGENTS 错题表第 10 条。这一条不做，预算功能等于假的。

**为什么不做预扣**：见 D029 第 3 条。宁可超出几分钱才停，也不要估算偏差把正常对话拦掉。

---

### ~~第 16 步：引用决策（D030）~~ ✅ 已完成

- [x] `src/modules/persona/quote.ts`：`decideQuote` / `stableRoll` / `parseQuoteTendency`
- [x] `Persona.quoteTendency`（`never|rare|normal|often`，默认 `normal`），迁移 `20261024134146_persona_quote_tendency`
- [x] 必要性硬判 7 条（自引 / 直接回应 / 最新冗余 / 私聊连发 / 群聊多人 / 超时 / 隔太多条）
- [x] 中间地带按倾向概率，`never` 阈值 0 但**不压制必要引用**
- [x] 确定性随机（FNV-1a 按 target id），同一消息永远同一结果
- [x] `QuoteReason` 覆盖所有分支（含不引用的原因），便于排查

**验收**：`pnpm test` **259 个用例全绿**（新增 19 条，其中 4 条专门断言"禁止引用"的场景）。

**为什么模型不参与**：模型看不到时序与人数、拿不到 message id、结果不可复现；
更麻烦的是它有**客服倾向**——只要给了"可以引用"的选项就会多用，把"话少冷淡"的人格演成客服。
详见 D030。

---

### ~~第 17 步：会话窗口（D031）~~ ✅ 已完成

- [x] `src/modules/session/window.ts`：`buildWindow` / `flattenWindow` / `windowQuoteFacts`（纯函数）
- [x] 三重约束取交集：`maxMessages` / `maxAgeMs` / `maxChars`（私聊 20/2h/4000，群聊 40/2h/6000）
- [x] **target 必须在窗口里**，哪怕它很老、后面刷了几十条
- [x] **after 优先于 before**：after 不按时间裁、只受条数/字符预算；before 才受 maxAgeMs
- [x] **afterTotals 用未裁剪统计**：count 与发言人数在数据库端单独算，不随窗口裁剪失真
- [x] 裁剪"整体停下"不挖洞；同毫秒兄弟消息宁可丢不硬救（cuid 不单调）
- [x] `src/modules/session/ports.ts` + Prisma 取数：带 sessionId 查 target，跨会话返回 null
- [x] `scripts/window-smoke.ts`：真实 SQLite 六项全过

**验收**：`pnpm test` **275 个用例全绿**（新增 16 条窗口用例）；
`window-smoke` 通过（before/after 边界、afterTotals 全量 40 条、跨会话拒绝、multi_speaker 引用、私聊冗余不引用）。

**和 D030 的接缝**：`decideQuote` 增加 `afterTotals?` 入参，群里刷屏时引用判定依据全量统计，
不因窗口裁剪而误判成"单人对话"。

---

### ~~第 18 步：Pipeline 主链路（M2 收尾）~~ ✅ 已完成

- [x] `session/persistence.ts` + `prisma-session.repository.ts`：会话 upsert（`[instanceId,kind,peerId]` 唯一）+ 消息落库
- [x] `persona/prompt.ts`：种子字段 → system prompt（D020 顺序：人 → 出生设定 → 对方 → 情境 → 软禁区）
- [x] `pipeline/ports.ts` + `prisma-pipeline.repository.ts`：按 instanceId 取 owner + activePersona
- [x] `pipeline/pipeline.service.ts`：完整链路 + 故障兜底（限频、可能静默）
- [x] `pipeline/pipeline.module.ts` + tokens；替换 `instance.service` 的 pong 占位回显
- [x] 修复 `app.module` 里 `ModelModule`/`AgentConfigModule` 被 import 但未注册的 bug
- [x] `scripts/pipeline-smoke.ts`：真实 SQLite 走通私聊对话（4 项断言）

**验收**：`pnpm test` **295 个用例全绿**（新增 prompt 13 + pipeline 7）；
`typecheck` / `build` / 数据闸门 PASSED；`pipeline-smoke` 通过（出站、不引用、落库 6 条、会话唯一）。

**M2 刻意没做的（留给 M3）**：attention（要不要回，现在有消息就回）、think（内心独白）、
moderate（输出审核）、express（拆条/打字延迟）。这些是 M3 的 Pipe，不是 M2 的遗漏。

**Pipeline 的出站回调设计**：`send` 作为 `handle(message, send)` 的参数而非依赖注入 ——
因为 send 绑定到"当前这条连接的 adapter"，每个实例的 adapter 不同，不能全局注入一个。

---

### ~~第 24 步：M4-1 人设 API——增删改查 / 发布 / 归档 / 启用~~ ✅ 已完成（D037）

**做了什么**

- [x] `src/modules/persona/dto.ts`：入参出参都是**对象**（不是 JSON 字符串），
      `behavior` / `fallbacks` / `identity` / `examples` / `promptBlocks` 全部 zod 严格校验
      （拼错字段名 400，而不是"保存成功但没生效"）
- [x] `ports.ts` + `prisma-persona.repository.ts`：所有读都带 `instance.ownerUserId`，
      没有 `findById`；列表默认不含归档
- [x] `persona.service.ts`：生命周期规则（D037）—— 草稿不能启用、改已发布即 version+1 并刷新快照、
      发布幂等、归档顺手解除 `activePersonaId`、每个写动作留审计（只记 name/status/version）
- [x] `persona.controller.ts`：7 个路由（列表/新建/详情/更新/发布/归档/启用），全部走 `SessionGuard`
- [x] 审计新增 5 个 action（`persona.create/update/publish/archive/activate`）

**验收**

- `pnpm test` **479 个用例全绿**（新增 27：persona service 13 + dto 14）
- `pnpm typecheck` / `pnpm build` 通过
- `http-smoke` **42 项**全过（新增 10 项人设流程：新建草稿→列表→草稿启用被拒→发布→启用→
  改已发布升版本→拼错字段 400→合法参数落库→404→归档并解除激活）
- `pnpm check:local-data` PASSED（235 个文件）

**接口清单（M4-2 前端直接用）**

```
GET    /api/instances/:instanceId/personas[?includeArchived=1]
POST   /api/instances/:instanceId/personas
GET    /api/personas/:id
PATCH  /api/personas/:id
POST   /api/personas/:id/publish
POST   /api/personas/:id/archive
POST   /api/personas/:id/activate
```

**实现补充（后续不要改）**

- **改已发布的人设 = 新版**（version+1 + 刷新快照）。不要改成"退回草稿"：那会让线上瞬间没有人设。
- **草稿不能启用**：409 并提示"请先发布"。
- **归档解除激活**：否则排查时会看到"archived 人设在生效"。
- **审计不记人设正文**：内容可能很长、也可能含私人设定。
- **出参把 JSON 字段还原成对象**，库里的脏 JSON 宽容回落空结构（编辑页不该被一条坏数据打挂）。

---

### ~~第 23 步：M3-4 双阶段生成——内心独白 → 外显~~ ✅ 已完成（D036）

**做了什么**

- [x] `src/modules/mind/reflection/think.ts`：思考指令、宽容解析（容忍解释文字与 ```json 代码块）、
      `emotion_shift` 夹在 ±0.3、导演指令（**明确"不要说出口"**）
- [x] `src/modules/mind/reflection/policy.ts`：`behaviorJson.think.enabled` 开关（默认开）
- [x] Pipeline：A 阶段 `purpose: 'think'`（走 `modelCheap` 记账）→ 独白拼进 system 作为导演指令 →
      B 阶段主模型生成；**think 失败/不是 JSON 一律退化为单阶段**，不影响回话
- [x] `emotion_shift` 接 `applyReply({ moodShift })`：mood 终于开始被推动（此前只回归）
- [x] `Message.thinkJson` 落库：只供排查，**绝不回灌对话历史**

**验收**

- `pnpm test` **452 个用例全绿**（新增 19：think 13 + pipeline 6）
- `pnpm typecheck` / `pnpm build` 通过
- `pipeline-smoke` **10 项**全过（新增⑩：`think → chat` 调用序列、独白落库、mood 被推动）
- `http-smoke` 32 项全过；`pnpm check:local-data` PASSED

**实现补充（后续不要改）**

- **思考不进历史**：进了下一轮，模型就开始"演内心戏"，越演越假。只落 `thinkJson`。
- **think 失败就退化单阶段**，绝不因为"没思考成"而不回话（D011）。
- **`want_to_reply` 只影响语气，不做二次否决**：attention 已经决定回不回，模型再否决会出现"叫了不应"。
- **成本翻倍**：每条消息两次调用（A 用 cheap、B 用主模型）。不要这个成本就设
  `behaviorJson.think.enabled = false`。

---

### ~~第 22 步：M3-3 表达层——拆条 / 打字延迟 / 回 @ / 会话串行~~ ✅ 已完成（D035）

**做了什么**

- [x] `src/modules/mind/expression/split.ts`：拆条（换行 → 句末标点 → 逗号 → 硬切；
      单条 ≤40 字、最多 3 条；**超出条数并进最后一条，绝不截断**；短回复不拆）
- [x] `src/modules/mind/expression/delay.ts`：首条 `0.8s + 字数×0.05s`（±30%），
      后续 `字数/4.5 秒`；忙碌 ×3、深夜（23:00–07:00）×1.6；总延迟 12s 上限按比例压缩
- [x] `src/modules/mind/expression/rand.ts`：消息级种子（`seededRand(会话+消息id)`），
      延迟与拆法的随机可复现；明确**不可用于安全用途**
- [x] `src/modules/mind/expression/plan.ts`：总装计划（每条的延迟 + 是否回 @）；
      参数来自 `behaviorJson.expression`，逐字段回落
- [x] Pipeline：文本按计划拆条发送、图片与语音各自单独一条；**@ 与引用都只挂第一条，
      已引用则不再 @**；新增 `sleep` 注入点（测试/冒烟不真等）
- [x] Pipeline **同会话串行**：`instanceId + 会话` 的 promise 队列，后一条等前一条说完

**验收**

- `pnpm test` **433 个用例全绿**（新增 26：expression 22 + pipeline 4）
- `pnpm typecheck` / `pnpm build` 通过
- `pipeline-smoke` 9 项全过（含"每条前面都请求了延迟"的断言；媒体/素材的条数断言按新行为更新）
- `http-smoke` 31 项全过；`pnpm check:local-data` PASSED（227 个已跟踪文件）

**实现补充（后续不要改）**

- **拆条的唯一硬约束是"不丢内容"**：`maxCharsPerSegment` 是目标不是门槛；条数超了并进最后一条。
- **换行永远分段**：那是用户自己的分段意图，不受"短回复不拆"影响。
- **延迟只乘不减**，且有总上限（12s）。没有上限时一个 3000 字的回复能把会话卡几十秒。
- **同会话必须串行**：否则两条消息各自等各自的延迟，最后交错发出，比秒回还假。
  队列是进程内 Map，丢了只影响"同时来两条"。
- **随机走消息级种子**，线上"这条怎么慢成这样"可以重放。**它不是密码学随机**。
- **@ 与引用不重复**：已经引用就不再 @，两者都只挂第一条。

---

### ~~第 21 步：素材库——存图/表情，按别名取用~~ ✅ 已完成（D034）

**做了什么**

- [x] `prisma` 迁移 `media_assets`：`MediaAsset`（`instanceId` + `alias` 唯一、`sha256` 内容去重、
      `useCount` / `lastUsedAt` / `deletedAt` 软删）；挂 `instanceId`，跨平台不共享（D023）
- [x] `src/modules/media/assets/`：
  - `asset.service.ts`：存（别名校验、限额 200 张 / 单张 2MB、内容去重、重名拒绝）、
    取（按别名 → 本地绝对路径 + 记账）、清单（只给名字，按使用频次排序）
  - `repositories/prisma-media-asset.repository.ts`：每个方法都带 `instanceId`，`deletedAt: null` 是默认条件
- [x] `media/intent.ts` 扩两条指令：`[use]名字[/use]`、`[save]名字[/save]`（都独占一行；图片总数共用 2 张上限）
- [x] `IImageFetcher.fetch()`：素材保存要走**原始字节**（之前只有 data URL 通道）
- [x] Pipeline：`[save]` → 只存**这条消息里真实存在的图**；`[use]` → 查库取文件，查不到就跳过（不编、不发空消息）
- [x] prompt：素材清单进能力段（最多 12 条）；**没有素材时不提 `[use]`**，但 `[save]` 一直提
- [x] 适配器 `mface`（商城/收藏表情）→ 带 url 的 `image`，否则表情包存不进库

**验收**

- `pnpm test` **407 个用例全绿**（新增 25：assets 14 + intent 6 + pipeline 4 + adapter 1）
- `pnpm typecheck` / `pnpm build` 通过
- `pipeline-smoke` **9 项**全过（新增⑧存素材落盘、⑨按别名取出并发送 + `useCount` 记账）
- `http-smoke` 31 项全过；`pnpm check:local-data` PASSED（222 个已跟踪文件）

**实现补充（后续不要改）**

- **别名是唯一入口，不接受 URL**：否则 D033 好不容易堵上的 SSRF 面又开了。
- **重名拒绝、不覆盖；软删后名字仍占位**：覆盖或复用名字都会让旧对话里的 `[use]` 指到另一张图。
- **内容去重**：`assets/<sha256>.<ext>`，同一张图只存一份文件，但允许起多个别名。
- **清单必须跟着 prompt 走**：模型看不到库，只能从清单里挑；清单排序是"常用的、最近用过的"。
- **已知限制**：保存发生在模型输出之后，存失败时它那句"存好了"仍会发出去（不引入第二轮调用纠正，D034）。

---

### ~~第 20 步：多模态——看图 / 发图 / 发语音~~ ✅ 已完成（D033）

**做了什么**

- [x] `prisma` 迁移 `media_capabilities`：`BotInstance` 增 `modelVision` / `ttsCredentialId` / `ttsModel` /
      `ttsVoice` / `imageHosts`（全部实例级，随人格走，换 Provider 不动）
- [x] `src/modules/media/image-url.ts`：远程 URL 白名单与私网拦截（IP 字面量 / 单标签域名 /
      `*.local` / `user:pass` 全拒），入站允许 http、出站只允许 https
- [x] `src/modules/media/fetcher.ts`：入站图片下载 → data URL（4MB 上限、8s 超时、失败只丢这一张）
- [x] `src/modules/media/intent.ts`：媒体指令解析（独占一行、图片 ≤2、语音 ≤300 字）、
      `stripStrayMediaTags` 防写错的标签漏给用户
- [x] `src/modules/model/providers/openai-speech.ts` + `src/modules/media/tts.ts`：
      OpenAI 兼容 `/audio/speech`，按内容 hash 落盘 mp3 并缓存，失败一律降级为文字
- [x] `ChatMessage.content` 支持段数组；`GatewayInput.model` 支持指定视觉模型，
      且视觉请求**不参与预算降级**
- [x] Pipeline：入站图片挂在**当前这条**消息上（历史图不重发）；出站"文本+图片一条、语音单独一条"；
      平台不支持语音时把语音内容改说成文字
- [x] prompt 增「媒体能力」段：只列真的可用的通道
- [x] **修 M2 遗留缺陷**：主链路按 owner 取 DEK（`RuntimeKeyStore.getForUser`），
      此前用 chat session id 查密钥库，真机上必然拿不到 → 消息全被静默吞掉

**验收**

- `pnpm test` **382 个用例全绿**（新增 43：media 28 + pipeline 媒体 8 + prompt 4 + key store 4，另有既有夹具调整）
- `pnpm typecheck` / `pnpm build` 通过
- `pipeline-smoke` **7 项**全过（新增⑦：模型回"图片+语音"→ 发出 2 条，语音文件真实落盘）
- `http-smoke` 31 项全过（独立库、端口 3111）
- `pnpm check:local-data` PASSED（210 个已跟踪文件）

**实现补充（后续不要改）**

- **没配就不提**：prompt 里的媒体能力段由配置驱动。没配 TTS 就不写 `[voice]` ——
  否则模型会说"我发你语音"，然后什么都没有。
- **校验失败就丢，不原样发给用户**：`[img]http://127.0.0.1/...[/img]` 这类留在正文里就是垃圾。
- **语音文件用内容 hash 命名**（`data/media/tts/<sha256 前 32 位>.mp3`），绝不用模型文本拼路径。
  同一句话只存一份 = 天然缓存。**目前没有自动清理**（M6 的 worker 按 mtime 保留 N 天）。
- **出站图片只在 https 白名单（可选）内**：图片是协议端去下载的，链到内网等于让它当内网探测器。
- **语音失败 → 文字兜底**，包括"平台不支持语音"这种情况（`voiceAsText`），不要让回复凭空消失。

---

### ~~第 19 步：M3-1/2 状态机 + 发言决策~~ ✅ 已完成

**做了什么**

- [x] `src/modules/mind/state/mind-state.ts`：`mood` 每小时向基线回归 8%；
      `energy` 按 24 小时作息曲线收敛（τ=2.5h，深夜 0.40 / 上午 0.88 / 午后低谷 0.72）；
      回一条扣 0.02；过期的 `busyUntil` 由衰减顺手清空
- [x] `src/modules/mind/state/relationship.ts`：亲密度单次涨幅 = 私聊回话 1 / 群聊 0.6 /
      只读不回 0.2，被 @ 再 +0.4，长消息最多 +0.4，单次封顶 2；7 天宽限期后每天 -1
- [x] `src/modules/mind/state/ports.ts` + `prisma-mind-state.repository.ts`：
      `AgentState` / `Relationship` 两张表按实例 upsert
- [x] `src/modules/mind/attention/policy.ts`：从 `Persona.behaviorJson.attention` 解析阈值与权重，
      **逐字段回落**默认（一个字段写错不连累其它字段）
- [x] `src/modules/mind/attention/attention.ts`：`wake` 公式 + 阈值判定；
      **群里被 @ 必回**（硬规则，不受阈值与精力影响）；`busy` 只抬高群聊阈值，不影响私聊
- [x] `src/modules/mind/attention/signals.ts`：`followUp`（上一条是它说的，10 分钟内）与
      `groupActivity`（10 分钟内条数 / 12）都从会话窗口推，不新增查询
- [x] `persona/prompt.ts` 新增「语气提示」段（D020 顺序最后一段）：只在精力/情绪偏离常态时说话，
      且说现象不说指令
- [x] Pipeline 接入：配置提前读（会话开关）、状态先衰减再判定、判定不回则**不调模型**、
      两条路径都回写状态与关系；状态层异常一律吞掉，不影响对话
- [x] `scripts/pipeline-smoke.ts` 扩到 6 项：真实 SQL 验证 `AgentState` 单行 upsert 与
      `Relationship` 亲密度增长

**验收**

- `pnpm test` **338 个用例全绿**（新增 43：state 11 + relationship 10 + attention 10 + policy 4 + prompt 4 + pipeline 4）
- `pnpm typecheck` / `pnpm build` 通过
- `pipeline-smoke` 6 项全过（energy 0.740 / affinity 3）
- `http-smoke` 31 项全过（独立库 `zk.db`、端口 3111）
- `pnpm check:local-data` PASSED（199 个已跟踪文件）

**实现补充（后续不要改）**

- **衰减的起点只有一个**：每次衰减的量都按 `lastDecayAt → now` 算，返回值的 `lastDecayAt` 推进到 `now`。
  这样"漏写库一次"只会让下次从更早的起点重算（结果相同），不会叠加衰减。精力一旦写成
  "每次调用扣一点"，查询与定时任务都会偷偷扣，最后表现为"人格莫名其妙没精神了"。
- **时钟回拨不衰减**，但 `busyUntil` 是否过期照常判断——它是"此刻的事实"，与经过多少时间无关。
- **`mood` 目前没有推动来源**：只有回归基线。真正的推动量来自 M3-4 内心独白的 `emotion_shift`；
  现在凭文本猜情绪等于瞎猜，猜错比不动更糟。所以提示词里 mood 只在 `|mood| ≥ 0.25` 时出现，
  日常几乎不会触发——这是刻意留白，不是漏做。
- **attention 在网关之前**，这是它省钱的地方；因此它**看不到模型输出**，只判"要不要开口"，
  判错了最多少说一句，不会答错。
- **不用随机数**：同一组输入永远同一结论（可复现、可精确断言）。"偶尔看一眼不回"的随机性由
  状态变化体现（精力在掉、亲密度在涨），比扔骰子更接近真实原因（D032）。
- **会话静默 / 人工接管时连状态都不写**：那时说话的"不是它"，算进亲密度会让关系变成客服的关系。
- **亲密度衰减只在写库时算一次**，算完把 `lastInteractionAt` 推到 now。写成"每次调用都扣一点"
  会让同一段空窗被反复扣到归零。

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

### ~~P0-1：反向实例启动自监听~~ ✅ 已完成（2026-10-24，见 D019）

云端常驻的前提：服务重启后不需要任何人登录，反向实例能自己恢复监听。

- [x] `BotInstance.accessTokenDigest` + 迁移；create/update 同步维护，清 token 时一起清
- [x] 反向连接不再需要 DEK：主服务注入 `verifyPeerToken`（HMAC 摘要），适配器不接触明文
- [x] `OneBotWsServer` 要求 `verifyToken` 必填——没有校验手段就拒绝监听
- [x] `InstanceBootstrapService`：`onApplicationBootstrap` 恢复监听，fire-and-forget，失败只告警
- [x] 老数据（无摘要）启动时跳过；用户手动连接一次自动回填摘要
- [x] 真机验证：重启服务后**全程不登录** → 自监听恢复 → NapCat 自动连入 → `status=online`；
      同时错误 token 仍被 HTTP 401 拒绝
- [x] 测试：`token-digest` 7 个 + 服务层 5 个（无 DEK 连接 / 自监听 / 跳过与回填 / 清 token）

**代价**：换 `SESSION_SECRET` 会让所有摘要失效 → 需要在后台重新保存一次 token（已写进 SECURITY）。

### M2 最小闭环 ✅ 已完成

- [x] AgentConfig / ConfigResolver（四级覆盖 + provenance + 缓存失效）
- [x] `ModelGateway`：路由 + 超时 + 重试 + 记账
- [x] `openai-compatible` Provider
- [x] Persona 拼装 system prompt（未决问题 6 已由 D030 定稿）
- [x] 私聊能正常对话

### M3 拟人

- [x] 状态机（mood / energy / affinity）—— `mind/state/`（第 19 步，D032）
- [x] 发言决策器 —— `mind/attention/`，判定在调模型之前（第 19 步，D032）
- [x] 多模态：看图 / 用图片回复 / 发语音（第 20 步，D033）
- [x] 素材库：存表情/图片、按别名取用（第 21 步，D034）
- [x] 双阶段生成（内心独白 → 外显）—— 第 23 步，`mind/reflection/`（D036）
- [x] 表达层（拆条 / 打字延迟 / 回 @ / 会话串行）—— 第 22 步，`mind/expression/`（D035）
- [x] **是否引用上一条** —— 机制已就位（D030，`persona/quote.ts` + `Persona.quoteTendency`），
      M3 接出站时调用 `decideQuote()` 即可。引用不是默认行为：真人只在这一句需要指回上文时才引用。
      M1 的占位回声曾经无条件引用（`replyToMessageId`），看着很机械，已去掉；协议层能力保留。
- [ ] 行为拟人（夜间静默 / 连续发送上限 / 相似内容拦截）

### M4 管理后台

> 目标：M1~M3 阶段**没有页面**，操作一律走 HTTP 接口（`scripts/connect-instance.ts` 是临时的连接入口）。

- [x] 人设 API（第 24 步，D037）
- [ ] Vue3 工程 + 登录页
- [ ] 人设编辑器（后端已就绪，只差界面）
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
- [x] 2026-10-24 **人格归属定稿（D023）**：先做 Agent 层 → 用户澄清边界 → 当日回退；人格与记忆挂 `BotInstance`，跨社交平台不共享、跨 Provider 零迁移
- [x] 2026-10-24 **人格预算（D024）**：预算与超限策略挂 `BotInstance`，`Credential` 不再有预算字段；实例接口可读写
- [x] 2026-10-24 **余额与故障分级（D025）**：余额三态 + 熔断只暂停路由 + 兜底按故障时长分级；Provider 预设表落地
- [x] 2026-10-24 **兜底话术（D026）**：`Persona.fallbacksJson` 三槽位 × 私聊/群聊，`null` = 不说；预存文本 + 规则校验
- [x] 2026-10-24 **配置解析（M2-1）**：四级覆盖 + provenance + 30s 缓存与写路径失效；实例可切模型/Key（含归属校验，D027）
- [x] 2026-10-24 **ModelGateway（M2-2）**：错误分类 + openai-compatible 适配 + 选路/重试/熔断/记账；202 单测
- [x] 2026-10-24 **故障→话术映射（D028）**：欠费走 `longOutage` 话术、不做主动通知；映射与限频独立成模块
- [x] 2026-10-24 **预算拦截（D029）**：网关内判定、降无可降则拒绝、不做预扣；真实库冒烟覆盖聚合窗口
- [x] 2026-10-24 **引用决策（D030）**：必要性硬判 + 人格倾向概率，模型不参与；未决问题 6 定稿
- [x] 2026-10-24 **会话窗口（D031）**：target 必在窗口、after 优先、afterTotals 用未裁剪统计；真实库冒烟
- [x] 2026-10-24 **Pipeline 主链路（M2 收尾）**：会话/消息落库 + prompt 拼装 + 网关 + 引用 + 兜底，替换 pong 占位；295 单测
- [x] 2026-10-25 **状态机与发言决策（M3-1/2，D032）**：mood/energy 纯函数衰减 + 亲密度累积、attention 判定前置到网关之前（判掉不花 token）、状态与关系回写 Pipeline；338 单测
- [x] 2026-10-25 **多模态（D033）**：入站图片转多模态消息（独立视觉模型）、模型用独占行标记决定发图/发语音、TTS 落盘 mp3、出站 URL 白名单；顺带修掉"主链路按 chat session id 取 DEK"的 M2 缺陷；382 单测
- [x] 2026-10-25 **素材库（D034）**：`MediaAsset` 表 + `[save]`/`[use]` 指令 + prompt 清单，别名唯一入口、内容去重、重名拒绝；适配器补 `mface → image`；407 单测、pipeline-smoke 9 项
- [x] 2026-10-25 **表达层（D035）**：拆条 / 打字延迟 / 回 @ / 同会话串行 + 消息级可复现随机；433 单测
- [x] 2026-10-25 **双阶段生成（D036）**：think（modelCheap，JSON 独白）→ 导演指令 → 外显；emotion_shift 推动 mood；452 单测、pipeline-smoke 10 项
- [x] 2026-10-25 **M3 合并**：`feat/m3-mind` `--no-ff` 合入 `main`，打标签 `m3-persona`

---

## 未决问题

| # | 问题 | 影响 | 何时需要决定 |
|---|---|---|---|
| ~~1~~ | ~~NapCat 部署在哪（本机 / 服务器 / Docker）~~ → **已定**：先本机测试，确认后再迁云 | 结论：接入地址必须是**数据**（`BotInstance.endpoint`），不能是环境变量，否则换机器要改 `.env` 重启 | — |
| ~~2~~ | ~~用哪个 QQ 号做机器人（小号储备）~~ → **已定**：不写死，后台可增删/切换 | 结论：QQ 号存 `BotInstance.accountId`，一个号一条记录 | — |
| 3 | 是否需要语音消息（TTS / ASR） | 影响表达层与模型路由 | M3 |
| 4 | 人设是否要支持多套按时段切换 | 影响 Persona 与 Session 的绑定关系 | M4 |
| 5 | 是否需要群管理能力（欢迎、关键词） | 影响 Adapter 权限与风控 | M6 |
| ~~6~~ | ~~「引不引用上一条」由谁决定~~ → **已定（D030）**：代码判，模型不参与。必要性硬判（对方引用了机器人 / 群聊多人在说 / 超 60 秒 / 隔太多条 / 私聊连发）永不交给概率；其余中间地带由 `Persona.quoteTendency` 决定。实现见 `src/modules/persona/quote.ts`。 | — | M3 接表达层时调用 |
| ~~7~~ | ~~同一个人在不同社交平台的记忆是否合并~~ → **已定：不合并**（D023）。一个社交平台账号一份人格与记忆，换平台重新生成初始人格、从零演化；跨平台继承属另一个项目。 | — | — |
| **8** | **API Key 挂 User 还是挂 Agent**：现在是 `Credential` 挂 `User`（一个用户的多个 Key 组成池供降级链）。若一个用户要养多个 Agent 且**分开计费/隔离用量**，就得给 `Credential` 加 `agentId`，或改成多对多。 | 影响计费口径与密钥隔离边界 | M4 做 Agent 管理页时 |

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
| 2026-10-24 | 追加 D020/D021/D022（人格双层、模型可切换、重置分四档）；D007 曾按五级覆盖修订，同日撤回 |
| 2026-10-24 | M2-2：ModelGateway（分类/选路/重试/熔断/记账）+ openai-compatible Provider；202 单测 |
| 2026-10-24 | M2 开工：ConfigResolver（四级覆盖 + 来源追溯 + 缓存）与切换 Provider 的写路径（D027，含凭据归属校验）；185 单测 |
| 2026-10-24 | 追加 **D026**：兜底话术由用户按人格配置，预存文本、`null` = 不说、群聊默认不说；新增 15 条规则用例 |
| 2026-10-24 | 追加 **D025**：余额三态与熔断语义、兜底按故障时长分级、通知去重；`Credential` 加余额/冷却字段，新增 Provider 预设表；149 单测 |
| 2026-10-24 | **M2 完成**：Pipeline 主链路打通（会话/消息落库、prompt 拼装、网关、引用、兜底），替换 pong 占位；295 单测 + pipeline-smoke |
| 2026-10-24 | 会话窗口定稿（D031）：三重约束、after 优先、未裁剪统计；`session/window.ts` + Prisma 取数；275 单测 |
| 2026-10-24 | 定稿未决问题 6（D030）：引用由代码判，必要性不交给概率；新增 `persona/quote.ts` 与 `Persona.quoteTendency`；259 单测 |
| 2026-10-24 | M2-3：预算拦截（D029）+ 未定价告警；`budget-smoke` 真实库验证；240 单测 |
| 2026-10-24 | 追加 **D028**（修订 D025）：欠费也走人格话术、**不做主动通知**；故障→槽位映射与限频落到 `persona/fault-slot.ts`；新增 12 条用例 |
| 2026-10-24 | 追加 **D024**：预算挂人格（`BotInstance`），超限 `downgrade`/`block`；删除 `Credential` 上的预算字段；迁移 `budget_moves_to_instance`；144 单测全绿 |
| 2026-10-24 | 追加 **D023**：人格与记忆作用域 = 单个社交平台账号；撤回 `Agent` 层（迁移 `persona_scope_back_to_instance`），D020 归属段作废、四层结构与演化闸门保留；143 单测全绿 |
| 2026-10-24 | 建立分支纪律：M0 收尾与 M1 骨架分两次提交到 `feat/m1-adapter-and-instance`，合并前 typecheck / 112 单测 / build / 31 项冒烟 / 数据闸门全绿，`--no-ff` 合并并打标签 `m1-skeleton` |
| 2026-10-25 | M3 开工：状态机（mood/energy 纯函数衰减 + 亲密度累积/衰减）与发言决策（attention 前置到网关之前、群里被 @ 必回、busy 只影响群聊）落地并接入 Pipeline；338 单测、pipeline-smoke 6 项、http-smoke 31 项全过；追加 **D032** |
| 2026-10-25 | 多模态落地（D033）：`media/` 模块（URL 白名单、入站图片抓取、媒体意图解析、TTS）+ 实例字段迁移 `media_capabilities` + Pipeline 出站多媒体；修复主链路 DEK 取用键错误；382 单测、pipeline-smoke 7 项全过 |
| 2026-10-25 | 素材库落地（D034）：`MediaAsset` 迁移 + `assets/` 服务与仓储 + `[save]`/`[use]` 指令 + prompt 清单 + 适配器 `mface` 映射；407 单测、pipeline-smoke 9 项全过 |
| 2026-10-25 | 表达层落地（D035）：拆条（不丢内容）/ 打字延迟（只乘不减、12s 上限）/ 回 @ / 同会话串行 / 消息级种子；文本、图片、语音分开发；433 单测 |
| 2026-10-26 | 人设 API 落地（D037）：生命周期（草稿/发布/归档/启用）+ 严格校验 + 审计；479 单测、http-smoke 42 项 |
| 2026-10-25 | 双阶段生成落地（D036）+ M3 收尾：think→导演指令→外显、独白落库不回灌、emotion_shift 推动 mood；452 单测 / smoke 10 项 / http-smoke 32 项全过；合并 main 打标签 `m3-persona` |
