/**
 * 会话 / 消息的管理端只读查询（D043）。
 *
 * 三条设计：
 *
 * 1. **归属靠连表，不在应用层判断**：`Session` 没有 owner 列，用
 *    `where: { instance: { ownerUserId } }` 一步到位。拿别人的 instanceId 只会得到空结果。
 *
 * 2. **"最后一条消息"用一次 groupBy + 一次 OR 查询**，不是每个会话各查一条。
 *    50 个会话做 50 次往返在同进程 SQLite 上也能跑，但那是 N+1 —— 一旦换成网络数据库
 *    就会变成 50 次 RTT。这里用 `(sessionId, createdAt)` 的复合索引一次拿全。
 *
 * 3. **消息分页用 Prisma 内置游标**（`cursor: { id } + skip: 1`），排序是 `(createdAt desc, id desc)`。
 *    拆条发送时两条消息可能落在同一毫秒，只按时间比较会漏掉另一条。
 */

import type { PrismaClient } from '@prisma/client';

import type {
  ISessionAdminRepository,
  SessionMessageRow,
  SessionSummaryRow,
} from '../ports';

/** 会话列表要的字段。**不取 persona / 不取消息体** */
const SESSION_SELECT = {
  id: true,
  instanceId: true,
  kind: true,
  peerId: true,
  peerName: true,
  lastActiveAt: true,
  aiPaused: true,
  reviewMode: true,
  muted: true,
} as const;

const MESSAGE_SELECT = {
  id: true,
  role: true,
  senderName: true,
  content: true,
  createdAt: true,
  segmentsJson: true,
  thinkJson: true,
  blocked: true,
  blockReason: true,
} as const;

export class PrismaSessionAdminRepository implements ISessionAdminRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async isInstanceOwned(userId: string, instanceId: string): Promise<boolean> {
    const found = await this.prisma.botInstance.findFirst({
      where: { id: instanceId, ownerUserId: userId },
      select: { id: true },
    });
    return found !== null;
  }

  async listForUser(
    userId: string,
    instanceId: string,
    limit: number,
  ): Promise<SessionSummaryRow[]> {
    const sessions = await this.prisma.session.findMany({
      where: { instanceId, instance: { ownerUserId: userId } },
      select: SESSION_SELECT,
      // 最近聊过的排前面；id 兜底让顺序稳定（同毫秒创建的两个会话不会来回跳）
      orderBy: [{ lastActiveAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    if (sessions.length === 0) {
      return [];
    }

    const stats = await this.loadStats(sessions.map((session) => session.id));

    return sessions.map((session) => ({
      ...session,
      messageCount: stats.get(session.id)?.count ?? 0,
      lastMessage: stats.get(session.id)?.last ?? null,
    }));
  }

  async countForUser(userId: string, instanceId: string): Promise<number> {
    return this.prisma.session.count({
      where: { instanceId, instance: { ownerUserId: userId } },
    });
  }

  async findSessionForUser(
    userId: string,
    sessionId: string,
  ): Promise<{ id: string; instanceId: string; kind: string; peerId: string; peerName: string | null } | null> {
    const found = await this.prisma.session.findFirst({
      where: { id: sessionId, instance: { ownerUserId: userId } },
      select: { id: true, instanceId: true, kind: true, peerId: true, peerName: true },
    });
    return found ?? null;
  }

  async listMessages(input: {
    sessionId: string;
    limit: number;
    before?: string;
  }): Promise<{ rows: SessionMessageRow[]; hasMore: boolean }> {
    // 多取一条判断"还有没有更早的"，比再发一次 count 便宜
    const rows = await this.prisma.message.findMany({
      where: { sessionId: input.sessionId },
      select: MESSAGE_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      ...(input.before ? { cursor: { id: input.before }, skip: 1 } : {}),
    });

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    // 查询是倒序（为了靠游标往回走），返回给界面用正序（从前到后读）
    return { rows: page.reverse(), hasMore };
  }

  /**
   * 一次拿到这批会话的"消息条数 + 最后一条消息"。
   *
   * 步骤：先 `groupBy` 求每个会话的 `count` 与 `max(createdAt)`，再用 `(sessionId, createdAt)`
   * 的 OR 精确取回那几行。同一毫秒有多条时会多返回，取倒序后的第一条即可。
   *
   * 为什么不读 `Session.messageCount`：那个列**没有任何写入方**（`saveInbound` /
   * `saveOutbound` 都不维护它），永远是 0。读时现算虽然多一次查询，但永远不会漂移。
   */
  private async loadStats(sessionIds: string[]): Promise<
    Map<string, { count: number; last: NonNullable<SessionSummaryRow['lastMessage']> | null }>
  > {
    const grouped = await this.prisma.message.groupBy({
      by: ['sessionId'],
      where: { sessionId: { in: sessionIds } },
      _max: { createdAt: true },
      _count: { _all: true },
    });

    const stats = new Map<
      string,
      { count: number; last: NonNullable<SessionSummaryRow['lastMessage']> | null }
    >();
    const moments: Array<{ sessionId: string; createdAt: Date }> = [];
    for (const row of grouped) {
      stats.set(row.sessionId, { count: row._count._all, last: null });
      if (row._max.createdAt) {
        moments.push({ sessionId: row.sessionId, createdAt: row._max.createdAt });
      }
    }
    if (moments.length === 0) {
      return stats;
    }

    const rows = await this.prisma.message.findMany({
      where: {
        OR: moments.map((moment) => ({ sessionId: moment.sessionId, createdAt: moment.createdAt })),
      },
      select: { sessionId: true, role: true, content: true, senderName: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    for (const row of rows) {
      const entry = stats.get(row.sessionId);
      if (entry && !entry.last) {
        entry.last = {
          role: row.role,
          content: row.content,
          senderName: row.senderName,
          createdAt: row.createdAt,
        };
      }
    }
    return stats;
  }
}
