# aamps · AI 智能体接入多平台管理系统

给 AI 智能体配置独立的平台账号，接入 QQ、抖音、B站……让它**活得像个人**。

第一个落地的平台是 QQ（NapCat / OneBot 11）。其他平台以独立适配器包的形式接入，不在主服务里混合开发。

> 当前状态：**设计阶段完成，代码未开始**。进度见 [`docs/STATUS.md`](docs/STATUS.md)。

---

## 它能做什么

- 管理多个平台账号实例（QQ 起步，适配器可扩展）
- 配置 AI 人设卡片：性格、说话风格、示例对话、开场白、红线
- 管理多家 AI 服务的 API Key（DeepSeek / OpenAI / 通义 / 智谱 …），带用量与预算
- 配置行为约束词与规则引擎：输入拦截、输出审核、触发回复
- 让 AI 拟人地活着：判断该不该插话、分条发送、模拟打字节奏、有情绪和记忆

## 四条设计前提

1. **走第三方协议**，因为要求机器人和正常用户拥有一样的完整功能。
2. **优先拟人**，评判标准是"像不像人"，不是"功能全不全"。
3. **纯自用，但按多租户的形状组织代码**，后期能改造成共享服务。
4. **平台适配器独立成包**，新增平台是一个新子项目，不碰主服务与前端。

另有一条安全底线：**用户上传的 API Key 只有本人能看到明文，部署者也不行。**

---

## 文档导航

| 想了解 | 读这个 |
|---|---|
| 现在做到哪了、下一步做什么 | [`docs/STATUS.md`](docs/STATUS.md) |
| 为什么这么设计、哪些方案被否决了 | [`docs/DECISIONS.md`](docs/DECISIONS.md) |
| 整体架构、分层、消息管道 | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| 密钥怎么加密、权限怎么隔离 | [`docs/SECURITY.md`](docs/SECURITY.md) |
| 模型接入怎么做 | [`docs/MODEL-ACCESS.md`](docs/MODEL-ACCESS.md) |
| 代码怎么写 | [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) |

如果你或你的 AI 助手要接手这个项目，**先读 [`AGENTS.md`](AGENTS.md)**，那里有 5 分钟的接手流程。

---

## 技术栈

NestJS + Prisma + SQLite + Vue 3，OneBot 11 接入，Docker Compose 部署。

详细选型理由见 `docs/ARCHITECTURE.md` 第 2 节。

## 项目结构

这是一个 pnpm workspace，主服务与平台适配器分离：

```
packages/contracts     @newjob/contracts   主服务与所有适配器唯一的共享依赖
packages/adapter-qq    @newjob/adapter-qq  QQ 适配器（独立包）
src/                   主服务：编排、人设、模型、记忆、合规
```

想让 AI 也住进抖音或 B站？新建一个 `packages/adapter-douyin` 就行，**不需要碰主服务和前端**——前端表单是根据适配器自带的能力清单动态渲染的。详见 `docs/DECISIONS.md` 的 D013。

---

## 开始开发

```bash
pnpm install
cp .env.example .env      # 填入 DATABASE_URL 等
pnpm prisma migrate dev
pnpm dev
```

首次启动需要创建一个 superadmin 账号，见 `docs/STATUS.md` 的 M0 任务。

### 现在还没有管理后台

管理页面（Vue 3）排在 **M4**，M1~M3 阶段所有操作都走 HTTP 接口。为了不手拼 cookie，常用动作有脚本：

```bash
# 登录（= 验密码 + 解锁 DEK）→ 列出实例 → 连接选中的实例
ADMIN_USERNAME=你的用户名 ADMIN_PASSWORD=你的密码 pnpm tsx scripts/connect-instance.ts

# 接口自检（自己建账号、跑完整鉴权与实例流程，不碰真实数据）
BASE_URL=http://127.0.0.1:3000 pnpm tsx scripts/http-smoke.ts
```

接口清单看 `src/modules/*/*.controller.ts`，`GET /api/adapters` 会返回各适配器的 `configFields`，
M4 的配置表单就是照着它渲染的。

---

## 风险提示

本项目通过第三方协议接入 QQ，**存在账号被风控或封禁的风险**。系统内建了行为拟人（发送节流、夜间静默、频率上限、风控自动降级），但这只能降低概率，不能消除。

建议使用小号，并在首次运行时把风控参数调得比默认值更保守。
