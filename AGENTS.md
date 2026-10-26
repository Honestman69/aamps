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

仓库里**没有** `.env`、也没有数据库文件（都在 `.gitignore` 里）。新克隆直接 `pnpm dev` 会失败，按顺序来：

```bash
pnpm install                                   # 首次约 9 分钟，别以为卡死了
cp .env.example .env                           # 模板里的 DATABASE_URL 已经是对的，本地可直接用
pnpm prisma:generate                           # 生成 Prisma Client（缺它 tsc 会报找不到类型）
DATABASE_URL="file:../data/dev.db" npx prisma migrate deploy
pnpm build                                     # 先构建 packages/*，否则运行期 ERR_MODULE_NOT_FOUND
pnpm web:build                                 # 管理后台产物（可选：不构建则只有接口，没有页面）
pnpm test                                      # 全绿（用例数会随迭代增长，不写死数字）
pnpm dev                                       # 或 node dist/src/main.js
```

### 新机器上「不存在」的东西（换机器最容易漏）

| 东西 | 为什么不在 | 怎么办 |
|---|---|---|
| `.env` | 被 ignore | `cp .env.example .env`，里面已有可用的开发默认值 |
| `data/dev.db` | 被 ignore（目录只有 `.gitkeep`） | `migrate deploy` 建空库 |
| 管理员账号 | 存在库里 | 首次启动由 `BOOTSTRAP_ADMIN_*` 自动创建；**账号已存在则跳过，不会改密码** |
| 实例（QQ 号 / token / 接入地址） | 存在库里 | 重新建一条。想搬数据就整库搬 `dev.db`，但注意里面是密文，换机器后 DEK 不同解不开 |
| `.workbuddy/memory/` | 被 ignore | 读不到上一台机的本地日志 → **一切以 `docs/` 为准**，这也是为什么决策必须写进 DECISIONS |
| NapCat 及其登录态 | 仓库外 | **不要搬**（SECURITY 7.1）；新机重新扫码生成 |

### 只写代码不需要 NapCat

单测里用的是假 OneBot 服务端（`test/adapter-qq/`），`scripts/http-smoke.ts` 也不连真机。
只有"私聊收到 pong"这类真机联调才需要 NapCat，步骤见 `docs/STATUS.md` 第 7 步。

真机联调的形态：**NapCat 主动连我们**（反向 WS），本服务监听 `ws://127.0.0.1:3002`，
NapCat 的 `onebot11_<uin>.json` 里 `websocketClients[].url` 指向它、`token` 与实例一致。

### 两个自己踩过的坑，加一条纪律

1. **`BOOTSTRAP_ADMIN_PASSWORD` 只在首次建号时生效**。空库启动会新建管理员；
   账号已存在时跳过并打印原因，不会改密码。忘了密码只能走"重置密码"（会销毁 DEK）。
2. **`SESSION_SECRET` 缺失或短于 32 字符会直接拒绝启动**。这是刻意的——给它默认值等于公开所有会话签名。
   另外它派生 token 摘要，**换掉会让已保存的实例 token 失效**（D019）。
3. **NapCat 的数据目录不要搬**。换机器时在新机器上重新扫码登录生成，而不是把 `napcat/` 或
   `.config/QQ/` 复制过去——那里面是 QQ 登录态，等同于账号控制权（`SECURITY.md` 7.1）。

### 改完代码、提交之前（缺一条都不算完）

```bash
pnpm typecheck        # tsc --noEmit，含 packages/*
pnpm test             # 全绿
pnpm build            # 两个包 + 主服务都出产物
pnpm check:local-data # NapCat 登录态没混进版本库

# 动了 web/ 的话，再加这两条
pnpm web:typecheck    # vue-tsc --noEmit
pnpm web:build        # 产物能出来（挂载失败只有真浏览器能看出来）
```

端到端冒烟（要真服务 + 独立库，别指向 `dev.db`）见本节下方「分支与合并纪律」第 3 条。

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
9. **协议端的登录态永远留在协议端。** NapCat 的数据目录（`napcat/`、`.config/QQ/`、`onebot_<QQ号>.json`、`ntqq_*.json`）等同于**账号控制权**，不是缓存：
   - **不入 git**，提交前必须跑 `pnpm check:local-data`（它同时查已跟踪与未被忽略的文件）；
   - **不随迁移搬运**，换机器/迁云时在新机器上**重新扫码生成**，不要打包带走；
   - 接入地址默认只允许本机/内网，公网地址需显式 `ALLOW_REMOTE_ADAPTER=true`。
   详见 `SECURITY.md` 7.1。

10. **人格与记忆挂 `BotInstance`，不挂用户、不挂 Provider。** 一个社交平台账号一份人格与记忆：
    换社交平台 = 重新生成初始人格、从零演化（跨平台继承属另一个项目，见 D023）；
    换模型 Provider = **只改 `credentialId` / `modelMain`，人格与记忆零迁移**。
    `Persona` / `SelfState` / `MemoryItem` 里出现 provider / credential / model 字段，一律算错。

11. **业务逻辑写进 pipe，不要写回 `PipelineService`。** 管道是 13 个 pipe
    （`src/modules/pipeline/pipes/`），编排层只做"入队串行 / 跑链 / 兜底 / 清理"。
    加一种人格行为 = 新建一个 pipe 文件 + 在 `pipes/index.ts` 的清单里插一行，
    并如实填 `requires` / `provides`（`assertPipeGraph` 会在启动时校验）。
    在 pipe 里 `try/catch` 兜底也算错：兜底是编排层的职责（D040）。

12. **出站形态由代码决定，模型只产出"说什么"。** 引用哪条、要不要引用、拆不拆条、延迟多久、
    以及在故障时说不说兜底话术——全部在 `src/` 里判（D026/D028/D030）。
    **不要让模型输出 `quoteHint` / `split` / `delay` 这类结构化动作字段**：它拿不到 message id、
    看不到时序与人数，而且会被训练出来的"客服倾向"带偏，把人格抹平成客服。

---

## 新会话最容易犯的 13 个错

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
| 8 | 把 `napcat/`、`.config/QQ/`、`onebot_*.json` 复制到新机器或提交上去 | 那是 QQ 登录态 = 账号控制权，搬一次就多一份泄露面 | 新机器重新扫码生成；提交前 `pnpm check:local-data` |
| 9 | 所有失败都回同一句话术，或者反过来"欠费时每条消息都回一句" | 前者让 owner 分不清是欠费、Key 坏了还是我们的 bug；后者在群里是刷屏、在私聊是持续敷衍，比不说话更伤关系 | 按原因分槽位并**限频**：`faultToSlot` + `decideSpeak`（D028）。欠费也走话术，不做主动通知；用户配了 `null` 就必须静默 |
| 10 | 给实例设了预算，但凭据里没填目录价 | 每次调用都记 0 分，**预算永远不触发**；用户以为设了限额，实际一次都没拦住 | 建 Key 时填 `catalogJson` 价格；Gateway 有 warn，看到就补（D029） |
| 11 | 把 `web/dist` 或 `web/node_modules` 提交上去 | 产物是构建结果，冲突起来只能全量重编 | `.gitignore` 已覆盖；只提交源码 |
| 13 | 把新逻辑直接塞进 `pipeline.service.ts`（那里只剩编排） | 706 行的巨石就是这么做出来的；顺序与依赖一旦藏在注释里就没人维护 | 新建 pipe，填 `requires`/`provides`，在 `pipes/index.ts` 插一行（D040） |
| 12 | 为了让前端跨端口调用而打开 CORS + `SameSite=None` | 等于为开发方便削弱线上 cookie 策略（D005） | 开发期用 Vite 代理，生产期同源托管（D038） |
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
├─ web/                     Vue3 管理后台（独立 workspace 成员，产物由主服务托管，D038）
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

**提交前（缺一条都不算可合并）：**

```bash
pnpm typecheck          # tsc --noEmit
pnpm test               # 安全相关的必须通过
pnpm build              # 先包后主服务，验证产物能起
pnpm check:local-data   # 协议端数据（QQ 登录态）没混进版本库
```

---

## 分支与合并纪律（每个里程碑一次）

> 铁律：**先分支、后验证、再合并、留标签。** 任何"先合到 main 再说"的做法都等于放弃回档能力。

**1. 一个里程碑 = 一个分支**，命名 `feat/<scope>`：

```
feat/m1-adapter-and-instance      # M1 接入层
fix/audit-clock-rollback          # 修 bug
```

**2. 分支上按逻辑拆提交**（不是按文件），每条提交信息写清"验证了什么"。
一个提交要么能独立解释，要么说明它依赖前一条。**不要出现"一堆改动 + 'update'"**。

**3. 合并前必须全绿**，四条一起过（缺一条都别合）：

| 检查 | 命令 | 通过标准 |
|---|---|---|
| 类型 | `pnpm typecheck` | 无输出错误 |
| 单测 | `pnpm test` | 全绿，安全相关用例必须包含 |
| 构建 | `pnpm build` | 两个包 + 主服务都出产物 |
| 端到端 | `scripts/http-smoke.ts`（起真服务、真 SQLite） | `HTTP SMOKE PASSED` |
| 数据闸门 | `pnpm check:local-data` | `PASSED` |

端到端冒烟跑法（**别指向 `dev.db`**）：

```bash
rm -f data/zk.db* && DATABASE_URL="file:../data/zk.db" npx prisma migrate deploy
DATABASE_URL="file:../data/zk.db" PORT=3111 BOOTSTRAP_ADMIN_USERNAME=smoke_http_admin \
  BOOTSTRAP_ADMIN_PASSWORD=smoke-http-pass-01 node dist/src/main.js &
BASE_URL=http://127.0.0.1:3111 npx tsx scripts/http-smoke.ts
```

**4. 用 `--no-ff` 合并 + 打标签**，让"这个里程碑的整体状态"在历史里有一个可点名、可回退的锚点：

```bash
m=1                                  # 里程碑编号
git checkout main
git merge --no-ff feat/m1-adapter-and-instance -m "merge: M1 接入层"
git tag -a "m${m}-skeleton" -m "M1 骨架完成：适配器 + 实例管理 + 接入安全兜底"
```

**5. 分支合并后不要删。** 它和 tag 一起构成回档点；删了就只剩一条线性历史，
出问题时只能靠 `reflog` 找，而 `reflog` 会过期。

**出问题怎么回档（按严重程度选）：**

```bash
git log --oneline --graph --decorate -10   # 先看清形状
git revert -m 1 <merge-commit>             # 首选：撤销一次合并，保留历史，可再提交
git checkout m1-skeleton                   # 只是要看看当时的状态
git reset --hard m1-skeleton               # 最后手段：本地丢弃后续提交（已推送的别这么干）
```

**判断标准**：如果一条命令能把项目带回"上一个能跑的状态"，那这个里程碑就算归档好了；
如果回不去，说明标签或分支缺了，当时就该补。

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
