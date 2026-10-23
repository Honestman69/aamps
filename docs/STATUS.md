# 开发状态

> **这是唯一的进度真源。** 每次改动代码后必须更新本文件。
> 新会话接手时，直接从「下一步」开始，不要重新规划。

**最后更新**：2026-10-23
**当前阶段**：M0 安全底座（设计完成，契约层已落地，加密层未开始）

---

## 仓库

- 远程：`git@github.com:Honestman69/aamps.git`（网页：https://github.com/Honestman69/aamps）
- 分支：`main`，首个提交 `ceccdc6`
- 网络：本机 `github.com:22` 会被重置，`~/.ssh/config` 已配置走 `ssh.github.com:443` + `Compression yes`。
  直接 `git push` 即可；若出现 `Connection reset`，先重试一次，通常是网络波动。

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

### 第 2 步：密码学底座（`src/common/crypto/`）← 现在做这个

- [ ] `argon2.ts` —— `deriveKek(password, salt)`，参数 m=64MiB / t=3 / p=4 / hashLen=32
- [ ] `envelope.ts` —— `wrapDek` / `unwrapDek` / `encryptWithDek` / `decryptWithDek`
- [ ] `random.ts` —— `randomBytes` 的安全封装（DEK 32B、salt 16B、IV 12B）
- [ ] 密文格式严格为 `dek:v1:<iv>:<tag>:<cipher>` 与 `wrap:v1:<base64(iv)>:<base64(tag)>:<base64(cipher)>`

**验收**：`pnpm test` 通过三个用例——加解密往返、错误密码解不开、篡改密文触发 GCM 校验失败。

**注意**：用 `@node-rs/argon2`（Rust 实现，有预编译二进制），不要用 `argon2` 包——后者在 Windows 上要现场编译，容易卡住。

### 第 3 步：认证与密钥库（`src/modules/auth/`）

- [ ] `runtime-key-store.ts` —— 内存 Map，`set/get/clear`，**不持久化**
- [ ] `password.service.ts` —— `changePassword`（重包裹）与 `resetPassword`（销毁）两个独立方法
- [ ] `unlock.service.ts` —— 登录/解锁时解出 DEK 放入 store
- [ ] 审计哈希链 `audit.service.ts`

**验收**：`docs/SECURITY.md` 第 8 节的 14 条检查清单逐条通过。

---

## 任务看板

### M0 安全底座

- [ ] `User` 表迁移 + 种子数据（创建 superadmin）
- [ ] Argon2id KEK 派生
- [ ] DEK 生成 / 包裹 / 解包
- [ ] `RuntimeKeyStore`（内存，不落盘）
- [ ] 登录 → 解锁 → DEK 就位
- [ ] 锁定 / 会话过期满 → DEK 清除
- [ ] `changePassword`：单事务重包裹，Key 不变
- [ ] `resetPassword`：销毁 wrappedDek + 停用全部 Credential
- [ ] 审计日志 + 哈希链 + 完整性校验接口
- [ ] 零知识验收：用 superadmin 登录，抓所有接口，只看得到 `sk-****a1b2`

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
