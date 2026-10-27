/**
 * 记忆仓储的 Prisma 实现。
 *
 * 两条查询各管一件事：
 *   - **事实**按 `(instanceId, subjectId, scope)` 取，跨会话成立 —— 换一个群聊天，
 *     "他养了只猫"仍然成立；
 *   - **摘要**按 `(sessionId, scope)` 取，只在那个会话里成立 —— 在 A 群聊的总结
 *     拿到 B 群去用，会变成"强行套近乎"。
 *
 * 排序说明：事实按 `importance desc, createdAt desc`（重要的先记住；同分取新的），
 * 摘要按 `createdAt desc` 取最近 N 条再翻转成时间升序（prompt 里按时间读更自然）。
 */

import type { PrismaClient } from '@prisma/client';

import type {
  IMemoryRepository,
  PromptQuery,
  TranscriptMessage,
} from '../ports';
import type { MemoryDraft, MemoryRecord } from '../types';

type MemoryRow = {
  id: string;
  scope: string;
  kind: string;
  content: string;
  importance: number;
  subjectId: string | null;
  sessionId: string | null;
  createdAt: Date;
};

function toRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    scope: row.scope === 'semantic' ? 'semantic' : 'episodic',
    kind: row.kind,
    content: row.content,
    importance: row.importance,
    subjectId: row.subjectId,
    sessionId: row.sessionId,
    createdAt: row.createdAt,
  };
}

export class PrismaMemoryRepository implements IMemoryRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listForPrompt(
    query: PromptQuery,
  ): Promise<{ facts: MemoryRecord[]; summaries: MemoryRecord[] }> {
    const [facts, recent] = await Promise.all([
      this.prisma.memoryItem.findMany({
        where: {
          instanceId: query.instanceId,
          subjectId: query.subjectId,
          scope: 'semantic',
          // `expiresAt` 为空 = 永不过期
          OR: [{ expiresAt: null }, { expiresAt: { gt: query.now } }],
        },
        orderBy: [{ importance: 'desc' }, { createdAt: 'desc' }],
        take: query.factLimit,
        select: {
          id: true,
          scope: true,
          kind: true,
          content: true,
          importance: true,
          subjectId: true,
          sessionId: true,
          createdAt: true,
        },
      }),
      this.prisma.memoryItem.findMany({
        where: { sessionId: query.sessionId, scope: 'episodic' },
        orderBy: { createdAt: 'desc' },
        take: query.summaryLimit,
        select: {
          id: true,
          scope: true,
          kind: true,
          content: true,
          importance: true,
          subjectId: true,
          sessionId: true,
          createdAt: true,
        },
      }),
    ]);

    return {
      facts: facts.map(toRecord),
      // 取的时候是"最近的 N 条"（倒序），读进 prompt 要按时间正序
      summaries: recent.map(toRecord).reverse(),
    };
  }

  async lastEpisodicAt(sessionId: string): Promise<Date | null> {
    const row = await this.prisma.memoryItem.findFirst({
      where: { sessionId, scope: 'episodic' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return row?.createdAt ?? null;
  }

  async countMessagesSince(sessionId: string, since: Date | null): Promise<number> {
    return this.prisma.message.count({
      where: since ? { sessionId, createdAt: { gt: since } } : { sessionId },
    });
  }

  async listRecentMessages(sessionId: string, limit: number): Promise<TranscriptMessage[]> {
    const rows = await this.prisma.message.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, role: true, senderName: true, content: true, createdAt: true },
    });
    return rows.reverse();
  }

  async existingContents(
    instanceId: string,
    subjectId: string,
    contents: string[],
  ): Promise<Set<string>> {
    if (contents.length === 0) {
      return new Set();
    }
    const rows = await this.prisma.memoryItem.findMany({
      where: { instanceId, subjectId, content: { in: contents } },
      select: { content: true },
    });
    return new Set(rows.map((row) => row.content));
  }

  async addMany(drafts: MemoryDraft[]): Promise<number> {
    if (drafts.length === 0) {
      return 0;
    }
    const result = await this.prisma.memoryItem.createMany({
      data: drafts.map((draft) => ({
        instanceId: draft.instanceId,
        sessionId: draft.sessionId,
        subjectId: draft.subjectId,
        scope: draft.scope,
        kind: draft.kind,
        content: draft.content,
        importance: draft.importance,
        sourceMsgIds: draft.sourceMsgIds,
      })),
    });
    return result.count;
  }
}
