# AGENTS.md

> **这是给 AI 编码助手的入口文件。人类请看 `README.md`。**
>
> 如果你是一个新接手的会话（上下文已清空、或由别人接手），不要先问"这个项目是干什么的"，
> 按下面的接手流程走，5 分钟就能开始写代码。

---

## 项目一句话

**AI 智能体接入多平台管理系统**。给 AI 配置独立的平台账号，接入 QQ、抖音、B站……核心追求不是功能多，是**在每个平台里活得像个人**。

第一个落地的平台是 QQ（走 NapCat / OneBot 11）。其他平台以独立适配器包接入（见 D013），不在主服务里混合开发。

四个已锁定的前提：走第三方协议、优先拟人、纯自用但按多租户的形状组织代码、平台适配器独立成包。

---

## 接手流程（按顺序，不要跳）

| 步骤 | 读什么 | 得到什么 | 耗时 |
|---|---|---|---|
| 1 | `docs/STATUS.md` | 做到哪了、下一步写哪个文件 | 1 分钟 |
| 2 | `docs/DECISIONS.md` | 哪些设计已经锁死，**不要"优化"** | 2 分钟 |
| 3 | `docs/ARCHITECTURE.md` 第 1、3、5 节 | 分层结构、消息管道 | 2 分钟 |
| 4 | `docs/SECURITY.md` 第 1、4 节 | 哪些东西绝对不能碰 | 1 分钟 |

**然后直接从 `STATUS.md` 的「下一步」开始写代码。不要重新设计，不要问需求。**

其余文档（`MODEL-ACCESS.md`、`CONVENTIONS.md`、`ARCHITECTURE.md` 剩余章节）按需查阅，不要一次读完。

---

## 换机器 / 全新克隆（6 步，别跳）

仓库里**没有** `.env`，也没有 `data/*.db`（都在 `.gitignore` 里）。新克隆的仓库直接 `pnpm dev` 会失败，按顺序来：

```bash
pnpm install                    # 首次约 9 分钟，别以为卡死了
cp .env.example .env            # 然后改 DATABASE_URL="file:../data/dev.db"
                                # 注意：相对路径按 prisma/ 解析，不是项目根
pnpm prisma:migrate             # 或 DATABASE_URL=... npx prisma migrate deploy
pnpm build                      # 先构建 packages/*，否则运行期 ERR_MODULE_NOT_FOUND
pnpm test                       # 应为全绿（当前 51 个用例）
pnpm dev                        # 或 node dist/src/main.js
```

两个自己踩过的坑：

1. **`BOOTSTRAP_ADMIN_PASSWORD` 只在首次建号时生效**。换个空库跑会新建管理员；
   账号已存在时会跳过并打印原因，不会改别名密码。
2. **`SESSION_SECRET` 缺失或短于 32 字符会直接拒绝启动**。这是刻意的——给它默认值等于公开所有会话签名。

---

## 硬性规则（违反即返工）

1. **API Key 的明文只有上传者本人可见。** 部署者（superadmin）拥有全部系统权限，但**没有**读取 Key 明文的代码路径。这不是"暂不开放"，是架构级不可达。
2. **不做智能体框架。** 不自研 Agent 运行时、工具调用编排、RAG 引擎、模型训练。只做"密钥托管 + 请求包装 + 计量"。
3. **业务代码不认识 OneBot。** 只认 `InboundMessage` / `OutboundAction`，协议细节封在 `packages/adapter-*` 里。平台相关代码不许写进 `src/`。
4. **所有 LLM 调用走 `ModelGateway`。** 任何地方直接 `fetch` 模型接口都算错。
5. **Repository 层禁止 `findById` 这种无主查询。** 凭据类数据只暴露 `findForUser(userId, ...)`。
6. **密钥、Token、QQ 号不进日志。** 日志脱敏用白名单，不用黑名单。
7. **不判断平台字符串。** 需要知道"能不能主动发、字数上限多少、回复是否公开"，读 `adapter.capabilities`，不要写 `if (platform === 'qq')`。见 D012。
8. **文档与代码同步。** 改了架构就改 `ARCHITECTURE.md`，改了决策就改 `DECISIONS.md`，做完一步就更新 `STATUS.md`。

---

## 新会话最容易犯的 7 个错

前人都踩过，别重复：

| # | 错误做法 | 为什么不行 | 正确做法 |
|---|---|---|---|
| 1 | 用全局主密钥加密所有 API Key | 部署者持有主密钥 = 能解全部 Key，核心需求直接作废 | 每用户独立 DEK，见 D003 |
| 2 | 给 superadmin 加一个"查看 Key"按钮 | 违反核心需求，且会成为后门 | 权限枚举里不存在该 action |
| 3 | 引入 LangChain / Dify / 工作流引擎 | 违反 D002，把项目变成另一个东西 | 手写薄管道 |
| 4 | 把"改密码"和"重置密码"合成一个接口 | 两者安全语义相反，必有一边是错的 | 两条独立路径，见 D004 |
| 5 | 在 Controller 里直接 `prisma.xxx.findMany()` | 绕过 owner 过滤，等于密钥泄漏 | 走 Repository |
| 6 | 把 `mind`（拟人表现层）做成必须开启 | 它是可选装饰器，关掉也要能正常对话 | 每层可独立关闭 |
| 7 | 直接 `fetch('https://api.deepseek.com/...')` | 绕过重试、记账、降级、审计 | 走 `ModelGateway` |

---

## 目录地图

```
newjob/                         pnpm workspace
├─ AGENTS.md                ← 你正在读
├─ README.md                人类入口
├─ pnpm-workspace.yaml
├─ docs/
│  ├─ STATUS.md             ★ 进度真源，每次改代码必更新
│  ├─ DECISIONS.md          ★ 已锁定的决策，禁止回退
│  ├─ ARCHITECTURE.md       分层、管道、模块、里程碑
│  ├─ SECURITY.md           威胁模型、信封加密、权限矩阵
│  ├─ MODEL-ACCESS.md       模型接入模块（Provider/Key/Gateway）
│  └─ CONVENTIONS.md        编码约定与测试要求
├─ prisma/schema.prisma     数据模型（唯一真源，已 validate）
├─ packages/
│  ├─ contracts/            @newjob/contracts —— 主服务与适配器唯一的共享依赖
│  └─ adapter-qq/           @newjob/adapter-qq —— QQ 适配器（独立包，见 D013）
└─ src/                     主服务：编排、人设、模型、记忆、合规
   ├─ common/               配置、密码学（crypto）、日志
   ├─ modules/              业务模块（auth / model / persona / ...）
   └─ workers/              定时任务
```

**依赖方向是单向的**：`主服务 → 适配器包 → 契约包`。适配器永远不依赖主服务，这条由包结构保证。

**平台相关代码一律写在 `packages/adapter-*` 里，不许出现在 `src/` 下。**

---

## 工作协议

**开始工作前：**

1. 读 `docs/STATUS.md`，把要做的任务从「待办」移到「进行中」。
2. 确认任务没有依赖未完成项。

**结束工作后（必须做，否则下次接手会断档）：**

1. 更新 `docs/STATUS.md`：勾掉完成项，写清楚「下一步」具体到文件。
2. 如果做了架构或决策层面的变更，同步 `ARCHITECTURE.md` / `DECISIONS.md`。
3. 在 `.workbuddy/memory/YYYY-MM-DD.md` 追加一条简短日志（这是本地私有记忆，**不能替代** STATUS.md）。

**提交前：**

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # 安全相关的必须通过
```

---

## 文档的价值排序

如果时间有限，只维护前两个，其余可以滞后：

1. `STATUS.md` —— 没有它，接手的人不知道从哪开始
2. `DECISIONS.md` —— 没有它，接手的人会把已否决的方案重新做一遍
3. 其余（架构、安全、约定）

---

## 一句话交接

> **"读 STATUS.md 的下一步，写那个文件，写完更新 STATUS.md。"**
> 如果只能记住一句话，就是这句。
