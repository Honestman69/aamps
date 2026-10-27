/**
 * 记忆仓储的接口。
 *
 * 只有一个实现（Prisma），但仍然抽出接口 —— 理由和管道其他依赖一样：
 * 反思的"什么时候写、写什么"是纯逻辑，应该能在不建库的情况下测。
 */

import type { MemoryDraft, MemoryRecord } from './types';

/** 读回 prompt 的一次查询 */
export type PromptQuery = {
  instanceId: string;
  /** 当前会话：摘要按会话取（"我们上次聊到…"是会话级的） */
  sessionId: string;
  /** 当前对方：事实按人取（"他养了只猫"是人级的，跨会话都成立） */
  subjectId: string;
  factLimit: number;
  summaryLimit: number;
  /** 用来过滤已过期的情景记忆（`expiresAt` 为空表示永不过期） */
  now: Date;
};

/** 反思的原料：一条消息的"可读视图"（不带 id 之外的元数据） */
export type TranscriptMessage = {
  id: string;
  role: string;
  senderName: string | null;
  content: string;
  createdAt: Date;
};

export interface IMemoryRepository {
  /** 读回：这个人的稳定事实 + 这个会话最近的情节摘要 */
  listForPrompt(
    query: PromptQuery,
  ): Promise<{ facts: MemoryRecord[]; summaries: MemoryRecord[] }>;

  /** 该会话最后一条情节摘要的时间；没有则 null（用来算"距上次反思攒了多少条"） */
  lastEpisodicAt(sessionId: string): Promise<Date | null>;

  /** 该会话自 `since` 之后有多少条消息（`since` 为 null 表示从头算） */
  countMessagesSince(sessionId: string, since: Date | null): Promise<number>;

  /** 反思的原料：最近若干条消息（时间升序返回） */
  listRecentMessages(sessionId: string, limit: number): Promise<TranscriptMessage[]>;

  /**
   * 已经存在的同内容记忆。
   *
   * 用来挡住"同一件事被总结两遍"—— 每 30 条反思一次，长期关系里同一件事
   * 必然会反复出现（"他在做后端"），存十遍只会让 prompt 里重复十行。
   */
  existingContents(instanceId: string, subjectId: string, contents: string[]): Promise<Set<string>>;

  /**
   * 批量写入，返回**写进去的行**（带 id）。
   *
   * 返回 id 而不是条数，是因为人格演化必须能指回"这次真的记下了什么"（D046 溯源）。
   * 条数在这里没有用：调用方本来就知道自己提交了几条。
   */
  addMany(drafts: MemoryDraft[]): Promise<MemoryRecord[]>;
}
