/**
 * 会话窗口的 Prisma 取数。
 *
 * 三个查询的分工：
 *   1. target 自己（顺带校验它属于这个会话 —— 传错 sessionId 必须拒绝，不能跨会话读）；
 *   2. target 前后的切片（给模型看的原文）；
 *   3. after 的 count 与发言人数（**全量**，给引用决策用）。
 *
 * 第 3 条必须单独查：切片有 limit，而引用决策要判断"隔了几条、几个人在说"，
 * 拿被 limit 过的数量去算是错的。
 */

import type { PrismaClient } from '@prisma/client';

import type { WindowMessage } from '../window';
import type { ISessionWindowRepository, WindowSlice } from '../ports';

type MessageRow = {
  id: string;
  role: string;
  senderId: string | null;
  senderName: string | null;
  content: string;
  createdAt: Date;
};

function toWindowMessage(row: MessageRow): WindowMessage {
  return {
    id: row.id,
    role: row.role === 'assistant' || row.role === 'system' ? row.role : 'user',
    senderId: row.senderId,
    senderName: row.senderName,
    content: row.content,
    createdAt: row.createdAt,
  };
}

const SELECT = {
  id: true,
  role: true,
  senderId: true,
  senderName: true,
  content: true,
  createdAt: true,
} as const;

export class PrismaSessionWindowRepository implements ISessionWindowRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async loadSlice(input: {
    sessionId: string;
    targetMessageId: string;
    beforeLimit: number;
    afterLimit: number;
  }): Promise<WindowSlice | null> {
    const targetRow = await this.prisma.message.findFirst({
      // 带 sessionId 一起查：拿别的会话的 messageId 过来也读不到，避免跨会话串数据
      where: { id: input.targetMessageId, sessionId: input.sessionId },
      select: SELECT,
    });
    if (!targetRow) {
      return null;
    }

    // 严格用 lt / gt，**不**去"抢救"同毫秒的兄弟消息。
    //
    // 原因：`Message.id` 是 cuid，不是单调递增，同毫秒内无法判断谁先谁后。
    // 用 `OR + id != target` 看似能救回来，实际会把 target 之后的同毫秒消息
    // 当成"前文"塞进 before —— 那是把后文当前文，比丢一条严重得多。
    // 丢一条同毫秒消息的代价只是少一句上下文（极罕见，批量导入才会遇到）。
    const [beforeRows, afterRows, afterCount, speakerGroups] = await Promise.all([
      this.prisma.message.findMany({
        where: { sessionId: input.sessionId, createdAt: { lt: targetRow.createdAt } },
        orderBy: [{ createdAt: 'desc' }],
        take: input.beforeLimit,
        select: SELECT,
      }),
      this.prisma.message.findMany({
        where: { sessionId: input.sessionId, createdAt: { gt: targetRow.createdAt } },
        orderBy: [{ createdAt: 'desc' }],
        take: input.afterLimit,
        select: SELECT,
      }),
      this.prisma.message.count({
        where: { sessionId: input.sessionId, createdAt: { gt: targetRow.createdAt } },
      }),
      this.prisma.message.groupBy({
        by: ['senderId'],
        where: { sessionId: input.sessionId, createdAt: { gt: targetRow.createdAt } },
      }),
    ]);

    const before = beforeRows.map(toWindowMessage).reverse();
    const after = afterRows.map(toWindowMessage).reverse();

    return {
      target: toWindowMessage(targetRow),
      before,
      after,
      // count 与 after 查询用同一个条件（`gt`），两者口径一致；
      // 可能漏掉同毫秒的兄弟消息，方向偏保守（少算 → 更不容易触发必引用），不会答非所问。
      afterTotals: { count: afterCount, distinctSenders: speakerGroups.length },
    };
  }
}
