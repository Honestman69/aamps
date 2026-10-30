/**
 * 出站节流仓储的 Prisma 实现（M6-2 / D049）。
 *
 * 三个查询都把窗口下推到 SQL（`createdAt >= since` + `order by desc` + `take`），
 * 一个都不"全表捞出来再数"。
 */

import type { PrismaClient } from '@prisma/client';

import type { IOutboundRepository, OutboundRow } from '../ports';

export class PrismaOutboundRepository implements IOutboundRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listOutbound(sessionId: string, since: Date, limit: number): Promise<OutboundRow[]> {
    return this.prisma.message.findMany({
      // blocked 的不算"发出去过"：它们没到平台，计进限频会让真实额度被虚耗（D051）
      where: { sessionId, role: 'assistant', blocked: false, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { content: true, createdAt: true },
    });
  }

  async listRecentMessages(sessionId: string, limit: number): Promise<Array<{ role: string }>> {
    return this.prisma.message.findMany({
      where: { sessionId, blocked: false },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { role: true },
    });
  }

  async countOutboundForInstance(instanceId: string, since: Date): Promise<number> {
    return this.prisma.message.count({
      where: { role: 'assistant', blocked: false, createdAt: { gte: since }, session: { instanceId } },
    });
  }
}
