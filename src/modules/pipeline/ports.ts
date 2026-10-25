/**
 * Pipeline 的取数端口。
 *
 * Pipeline 是消息主链路，它需要三类数据，各来自不同地方：
 *   - 配置（模型/预算）→ ConfigService
 *   - 会话与消息（窗口）→ ISessionRepository + ISessionWindowRepository
 *   - 人设（拼 prompt）→ 这里
 *
 * 人设单独查而不塞进 ConfigService：拼 prompt 要 identity/tagline/examples/boundaries
 * 五个字段，而 ConfigService 只负责"配置面"（模型、预算、开关），不该为了拼 prompt
 * 把整个 Persona 拉进配置缓存。
 */

import type { PersonaSeed } from '../persona/prompt';

export type InstanceOwner = {
  instanceId: string;
  ownerUserId: string;
  /** 实例名，可作为机器人自己的名字 */
  name: string;
  /** 机器人自己的平台账号 id（QQ 号等），引用决策判断"是不是自引"用 */
  accountId: string;
};

/**
 * 实例当前生效人设的完整数据：prompt 拼装 + 兜底话术 + 引用倾向。
 *
 * 一次查询拿齐，避免 Pipeline 为同一张 Persona 表打三次。
 */
export type ActivePersona = PersonaSeed & {
  /** 故障兜底话术（D026），未配置时为 null → 用默认值 */
  fallbacksJson: string | null;
  /** 引用倾向（D030），脏值由 parseQuoteTendency 兜底 */
  quoteTendency: string;
  /** 行为参数（M3）：发言决策阈值/权重、表达层节奏。脏值逐字段回落默认 */
  behaviorJson: string;
};

export interface IPipelineRepository {
  /** 按 instanceId 拿 owner（Gateway 的 ownerUserId 从这里来）。找不到返回 null */
  findOwner(instanceId: string): Promise<InstanceOwner | null>;

  /** 拿实例当前生效的人设（拼 prompt + 兜底 + 引用）。没有人设返回 null */
  findActivePersona(instanceId: string): Promise<ActivePersona | null>;
}
