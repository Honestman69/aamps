# 开发状态

> **这是唯一的进度真源。** 每次改动代码后必须更新本文件。
> 新会话接手时，直接从「下一步」开始，不要重新规划。

**最后更新**：2026-10-23
**当前阶段**：M0 收尾（认证 + HTTP 层已完成，剩凭据管理与零知识验收）

---

## 仓库

- 远程：`git@github.com:Honestman69/aamps.git`（网页：https://github.com/Honestman69/aamps）
- 分支：`main`，首个提交 `ceccdc6`
- 网络：本机 `github.com:22` 会被重置，`~/.ssh/config` 已配置走 `ssh.github.com:443` + `Compression yes`。
  直接 `git push` 即可；若出现 `Connection reset`，先重试一次，通常是网络波动。
- 包管理器：本机原本没有 pnpm，已用 `corepack enable pnpm`（9.15.0）装好；依赖已 `pnpm install`。
  `corepack pnpm install` 首次约 9 分钟，别以为卡死了。
- 构建：`pnpm build` 先构建 `packages/*`（契约包 `main` 指向 `dist/index.js`）再编译主服务。
  只跑 `tsc` 不构建包，运行时会 `ERR_MODULE_NOT_FOUND`。
- **推送阻塞（2026-10-24）**：本地已积累 3 个提交待推送。本机 `git remote` 是 HTTPS，
  `credential.helper=manager` 但**没有已存储的 GitHub 凭据**，也没有 SSH 私钥，
  非交互终端无法输入账号密码 → `git push` 报 `could not read Username`。
  网络可达（`https://github.com` 200），**这是凭据问题不是网络问题**。
  解：在本地终端手动 `git push` 一次（会弹出 GitHub 登录并记住），或配置 PAT / SSH key。

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

### 第 5 步：凭据管理 + 零知识验收（M0 收尾）← 现在做这个

- [ ] `CredentialRepository`：只有 `createForUser` / `listForUser` / `findForUser(userId, id)` / `updateForUser` / `deleteForUser`，**没有 `findById` / `findMany`**
- [ ] `CredentialService`：新增时用 owner 的 DEK 加密（`decryptApiKey` 之外**不允许**其他地方碰明文）、只存 `keyMasked`
- [ ] 接口：`GET/POST /api/credentials`、`PATCH/DELETE /api/credentials/:id`
- [ ] DTO 收窄：类型里没有 `apiKeyEnc`，列表只返回 `keyMasked`（`sk-****a1b2`）
- [ ] 零知识验收：superadmin 抓遍所有接口 + 直查数据库，只看得到掩码

**验收**：`docs/SECURITY.md` 第 8 节剩余 1/2/3/4 条全部打勾；写一条"跨用户查询返回空"的测试（CONVENTIONS 要求）。

**注意**：`decryptApiKey` 的调用方最终只应有 `ModelGateway.dispatch()` 一处（`SECURITY.md` 5.3）。第 5 步写加密侧时**先不要写解密函数**，等 M2 的 Gateway 一起加，避免提前长出多个调用点。

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
- [ ] 零知识验收：用 superadmin 登录，抓所有接口，只看得到 `sk-****a1b2`（需 HTTP 层）

### M1 骨架

- [ ] NestJS 工程初始化（Fastify adapter）
- [ ] `.env` 加载与启动自检
- [ ] Prisma 迁移跑通
- [ ] **AdapterRegistry**：显式注册 `@newjob/adapter-qq` 的 factory，按 `manifest.protocol` 路由
- [ ] `packages/adapter-qq`：OneBot 11 WS 反向连接（`connect` / 心跳 / 重连）
- [ ] 事件转换：OneBot 原始事件 → `InboundMessage`（禁止把原始结构往上抛）
- [ ] 收到消息 → 回 `pong`
- [ ] 发送节流（全局令牌桶）

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
- [ ] 表达层（拆条 / 打字延迟 / 表情）
- [ ] 行为拟人（夜间静默 / 连续发送上限 / 相似内容拦截）

### M4 管理后台

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

---

## 未决问题

| # | 问题 | 影响 | 何时需要决定 |
|---|---|---|---|
| 1 | NapCat 部署在哪（本机 / 服务器 / Docker） | 影响 Adapter 连接配置与 IP 白名单 | M1 开始前 |
| 2 | 用哪个 QQ 号做机器人（小号储备） | 影响风控参数激进程度 | M1 开始前 |
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
