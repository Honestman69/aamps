# 编码约定

> 目的不是统一风格，是**让下一个人（或下一个 AI 会话）读代码时不需要猜**。

---

## 技术栈

| 项 | 版本 / 选择 |
|---|---|
| Node | 22 LTS |
| 语言 | TypeScript 5.x，`strict: true` |
| 后端 | NestJS 11 + Fastify adapter |
| ORM | Prisma 6 |
| 数据库 | SQLite（WAL） |
| 前端 | Vue 3 + Vite + Element Plus + Pinia |
| 包管理 | pnpm |
| 测试 | Vitest |
| KDF | `@node-rs/argon2`（**不要换 `argon2` 包**，见 D014） |

---

## 目录与命名

| 类型 | 规范 | 示例 |
|---|---|---|
| 模块目录 | kebab-case，单数 | `model/`, `persona/` |
| 文件 | kebab-case + 后缀 | `runtime-key-store.ts`、`password.service.ts` |
| 类 | PascalCase | `RuntimeKeyStore` |
| 接口 | `I` 前缀 | `IAdapter`、`ILLMProvider` |
| 类型 | PascalCase，无前缀 | `InboundMessage` |
| 常量 | UPPER_SNAKE | `DROP`、`MAX_SEGMENT_CHARS` |
| Prisma 模型 | PascalCase 单数 | `Credential`、`BotInstance` |

**一个文件一个主要导出。** 超过 300 行就拆。

---

## 分层约束

```
Controller  →  Service  →  Repository  →  Prisma
                 ↓
              Gateway / Adapter（外部调用）
```

- **Controller 不碰 Prisma**，也不写业务判断，只做参数校验与响应组装。
- **Service 不碰 `prisma` 客户端**，只调 Repository。
- **Repository 是唯一能写 `where` 的地方**，凭据类必须带 `ownerUserId`。
- **外部调用一律经过 Gateway / Adapter**，不允许在 Service 里直接 `fetch`。

### 归属字段怎么选（D020）

写任何带归属的表/查询前，先问一句：**"这是谁的经历"还是"从哪个口进来的"？**

| 问题 | 字段 | 典型 |
|---|---|---|
| 这是谁的经历 | `agentId` | 人设、记忆、关系、情绪 |
| 从哪个口进来的 | `instanceId` | 平台账号、会话、连接事件、限速/静默 |

- 记忆类数据可以**两个都带**：`agentId` 是归属（必填），`instanceId` 是来源渠道（可空）。
- 不要把"归属"写成"来源"：`where: { instanceId }` 查记忆 = 换个平台号就失忆，正是 D020 要避免的。
- 心情/精力挂 `agentId`（同一个人的），静默/限流/在线状态挂 `instanceId`（账号级的）。

### 包边界（monorepo）

```
主服务 (src/)  ──▶  @newjob/adapter-*  ──▶  @newjob/contracts
```

- 平台相关代码只能写在 `packages/adapter-*`，**禁止写进 `src/`**
- 适配器包**禁止** `import` 主服务的任何文件
- 适配器包**禁止**直接访问数据库、读取 DEK、实现重试/限流/记账——这些由主服务注入
- 契约包 `@newjob/contracts` 不依赖任何内部的包，它是依赖树的根

---

## TypeScript

```ts
// 不用 any。确实未知用 unknown 再收窄。
// 不用 enum，用 as const 对象 + 联合类型。
export const ProviderKind = { DeepSeek: 'deepseek', OpenAI: 'openai' } as const;
export type ProviderKind = typeof ProviderKind[keyof typeof ProviderKind];

// 对外 DTO 显式声明，且不含敏感字段
export type CredentialPublicDTO = {
  id: string; label: string; provider: string;
  keyMasked: string;              // 只有这个
  // 没有 apiKeyEnc —— 这是刻意的，不是遗漏
};
```

- 所有导出的函数写返回类型，不依赖推断。
- 禁止 `@ts-ignore`，必要时用 `@ts-expect-error` 并附原因注释。

### 第三方库的 `const enum`：运行时不存在

`@node-rs/argon2` 把 `Algorithm` / `Version` 声明成 `declare const enum`。这类枚举**只活在类型里**，
`require()` 出来是空对象，`Algorithm.Argon2id` 得到 `undefined`。而 esbuild / tsx / vitest 都不做
const enum 内联，于是值被静默传给底层库、回落到库的默认参数——代码照常跑，安全参数却被降级了。

遇到这类库，用带类型断言的数值常量，并写一条"反查参数"的测试：

```ts
const ALGORITHM_ARGON2ID = 2 as Algorithm;   // 不要写 Algorithm.Argon2id
```

判断标准：只要某个"配置项"影响安全等级（KDF 参数、加密算法、迭代次数），就必须有断言证明它真的生效。

---

## 错误处理

| 场景 | 做法 |
|---|---|
| 参数错误 | 抛 `BadRequestError`，Controller 统一转 400 |
| 权限不足 | 抛 `ForbiddenError`，**不区分"不存在"和"无权限"**（防枚举） |
| DEK 未解锁 | 抛 `KeyLockedError`，上层转成"需要解锁"提示，不降级 |
| 外部 API 失败 | 转成 `ProviderError`，带 `retryable: boolean` |
| 规则拦截 | 抛 `RuleBlockedError`，由管道捕获并决定是否回兜底话术 |

**所有错误对象里不允许出现密钥、Token、完整 QQ 号。** 错误信息会被记日志、可能被前端展示。

---

## 日志

```ts
logger.info({ event: 'llm.call', provider, model, tokenIn, tokenOut }, 'model call');
```

- 结构化字段优先于字符串拼接。
- **脱敏用白名单**：`logger` 只序列化 `event / provider / model / tokenIn / tokenOut / latencyMs / instanceId / sessionId` 这类字段。新增字段要显式加入白名单，而不是靠"记得排除密钥"。
- 每条消息链路带 `traceId`，从入站到出站贯穿。

---

## 数据库

- 迁移用 `prisma migrate dev`，**不允许手改数据库**。
- 软删除优先：`enabled = false` 而不是 `DELETE`（实例、人设）。
  **凭据是例外**，走物理删除，理由见 `DECISIONS.md` D015（留着的密文是负债）。
- 时间统一 UTC 存，展示时转本地。
- JSON 字段命名后缀 `Json`，应用层负责 `JSON.parse`，并**必须有对应的 zod schema 校验**（防止历史数据格式漂移导致崩溃）。

---

## 测试要求

不是所有代码都要测。但以下几类**必须有测试**，没有就不算完成：

| 范围 | 必须覆盖 |
|---|---|
| `common/crypto` | 加解密往返、错误密码失败、密文篡改触发 GCM 校验失败 |
| `auth/password` | 改密码后 Key 仍可解密；重置密码后 wrappedDek 为 null |
| `CredentialRepository` | 跨用户查询返回空 / 抛错，不能返回他人数据 |
| `ModelGateway` | 超时重试、401 不重试、降级链顺序 |
| 规则引擎 | 输入拦截、输出替换、优先级冲突 |

安全相关的测试用例命名要写清楚意图，例如：
`it('credentials of another user are not reachable even for superadmin')`

---

## 提交规范

```
<type>(<scope>): <subject>

feat(auth): 实现 DEK 信封加密与运行时密钥库
fix(model): 修正 401 被错误重试的问题
docs(decision): 追加 D004 密码变更双路径
```

type：`feat` / `fix` / `refactor` / `docs` / `test` / `chore`

**改了架构或决策，commit body 里必须指向对应文档章节。**

---

## 文档维护

| 改动 | 必须同步 |
|---|---|
| 完成一个任务 | `docs/STATUS.md` |
| 改变架构分层 / 新增模块 | `docs/ARCHITECTURE.md` |
| 做出新的技术取舍 | `docs/DECISIONS.md` 追加一条 |
| 改变安全机制 | `docs/SECURITY.md` + 检查清单 |
| 引入新的编码约定 | 本文件 |

**判断标准**：如果一个新会话只读文档、不读代码，能否正确地在现有设计上继续开发？如果不能，说明文档没写够。
