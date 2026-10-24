/**
 * Agent 仓储的 Prisma 实现。
 *
 * 注意 `ensureDefaultForUser` 里的取舍：并发首次调用理论上可能建出两个默认 Agent
 * （没有唯一键能表达"每个用户最多一个默认"，因为将来一个用户可以有多个 Agent）。
 * 这里不做补偿：M1/M2 阶段只有单一用户操作，撞不上；真正的归属选择在 M4 由用户显式指定。
 */

import type { PrismaClient } from '@prisma/client';

import type { AgentRow, IAgentRepository } from '../ports';

const DEFAULT_AGENT_NAME = '默认 AI';

export class PrismaAgentRepository implements IAgentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async ensureDefaultForUser(tenantId: string, ownerUserId: string): Promise<{ id: string }> {
    const existing = await this.prisma.agent.findFirst({
      where: { ownerUserId, status: 'active' },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    if (existing) {
      return existing;
    }
    return this.prisma.agent.create({
      data: { tenantId, ownerUserId, name: DEFAULT_AGENT_NAME },
      select: { id: true },
    });
  }

  async findForUser(ownerUserId: string, agentId: string): Promise<AgentRow | null> {
    return this.prisma.agent.findFirst({
      // 归属下推到 SQL：拿到别人的 agentId 也只得到 null
      where: { id: agentId, ownerUserId },
      select: { id: true, tenantId: true, ownerUserId: true, name: true, status: true },
    });
  }
}
