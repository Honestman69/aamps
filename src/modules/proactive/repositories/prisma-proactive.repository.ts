/**
 * 主动消息的 Prisma 仓储（M5-3 / D047）。
 *
 * 三条查询各对应一道闸，且都在 SQL 里做过滤：
 *   - 候选：`affinity >= ?` 且 `lastInteractionAt <= ?`（含 null 从没聊过的？**不**，见下）
 *   - 今天发了几条：`message.proactive = true` 且 `createdAt >= 今天零点`，连表到实例
 *   - 上次给某人发：同上，再按 `session.peerId` 过滤
 *
 * 「从来没聊过」的那批 `lastInteractionAt IS NULL` **不查出来**：
 * 没有对话就没有"想起你"的资格（`decideProactive` 里也挡了一道，这里少一次无用的循环）。
 */

import type { PrismaClient } from '@prisma/client';

import type { IProactiveRepository, ProactiveCandidate } from '../ports';

export class PrismaProactiveRepository implements IProactiveRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listEnabledInstanceIds(): Promise<string[]> {
    const rows = await this.prisma.botInstance.findMany({
      where: { proactiveEnabled: true, enabled: true },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  async listCandidates(
    instanceId: string,
    filter: { minAffinity: number; idleBefore: Date; limit: number },
  ): Promise<ProactiveCandidate[]> {
    const rows = await this.prisma.relationship.findMany({
      where: {
        instanceId,
        affinity: { gte: filter.minAffinity },
        // 必须真的聊过；只按 `<= idleBefore` 会把 `null` 排除在外 —— 正是想要的
        lastInteractionAt: { not: null, lte: filter.idleBefore },
      },
      // 越久没说话的越优先（"想起你"的顺序更像人）
      orderBy: { lastInteractionAt: 'asc' },
      take: filter.limit,
      select: { peerId: true, nickname: true, affinity: true, lastInteractionAt: true },
    });
    return rows.map((row) => ({
      peerId: row.peerId,
      peerName: row.nickname,
      affinity: row.affinity,
      lastInteractionAt: row.lastInteractionAt,
    }));
  }

  async lastProactiveAt(instanceId: string, peerId: string): Promise<Date | null> {
    const row = await this.prisma.message.findFirst({
      where: {
        proactive: true,
        session: { instanceId, peerId },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return row?.createdAt ?? null;
  }

  async countProactiveSince(instanceId: string, since: Date): Promise<number> {
    return this.prisma.message.count({
      where: {
        proactive: true,
        createdAt: { gte: since },
        session: { instanceId },
      },
    });
  }
}
