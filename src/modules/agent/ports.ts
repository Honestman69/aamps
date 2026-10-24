/**
 * Agent（AI 身份）仓储端口。
 *
 * 这一层存在的原因（D020）：记忆与人格属于 Agent，不属于某个社交账号。
 * 一个用户可以在多个平台各有一个号，但背后是同一个 AI。
 */

export type AgentRow = {
  id: string;
  tenantId: string;
  ownerUserId: string;
  name: string;
  status: string;
};

export interface IAgentRepository {
  /**
   * 取用户的默认 Agent，没有就建一个。
   *
   * 为什么实例创建时要"顺便保证"：M1/M2 阶段还没有 Agent 管理页，
   * 如果建实例必须先建 Agent，现有接口就断了。等 M4 有了页面，
   * 这里会变成"取用户选中的那个 Agent"，而不是"总是默认的那个"。
   */
  ensureDefaultForUser(tenantId: string, ownerUserId: string): Promise<{ id: string }>;

  /** 归属过滤：只能拿到自己的 Agent */
  findForUser(ownerUserId: string, agentId: string): Promise<AgentRow | null>;
}
