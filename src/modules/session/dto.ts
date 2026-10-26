/**
 * 会话查看的入参校验与管理端 DTO（D043）。
 *
 * 只读接口：没有写入口，也不提供"删除消息/清空会话"。理由写在 D043 ——
 * 消息记录是排查"机器人到底说了什么"的唯一证据，给它一个删除按钮，
 * 等于让最容易出问题的那一刻先把证据擦掉。
 */

import { BadRequestError } from '@newjob/contracts';
import { z, type ZodType, type ZodTypeDef } from 'zod';

import type { ThinkResult } from '../mind/reflection/think';

/** 一页最多 200 条：再大就不是"看记录"，而是"导出"了 */
const limitSchema = z.coerce.number().int().min(1).max(200);

export const sessionListQuerySchema = z
  .object({
    /** 会话列表按活跃时间倒序，默认 50。返回里的 `total` 用来判断有没有被截断 */
    limit: limitSchema.default(50),
  })
  .strict();

export const messageListQuerySchema = z
  .object({
    limit: limitSchema.default(50),
    /**
     * 游标：翻页时把上一页**最早那条**的 id 传回来。
     *
     * 用 id 而不是时间戳：拆条发送时两条消息可能在**同一毫秒**落库，
     * 用 `createdAt < x` 做游标会把同一毫秒的另一条直接漏掉。
     * id 是唯一键，配合 `(createdAt, id)` 复合排序才能保证不漏不重。
     */
    before: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

/**
 * 校验并返回**输出类型**。
 *
 * 签名把 Input 固定成 `unknown` 是刻意的：`ZodType<T>` 三参数默认会让 Input 也等于 T，
 * 于是带 `.default()` 的字段（输入可选、输出必填）会被推断成 `number | undefined`，
 * 调用方就得多写一个 `?? 默认值` —— 而默认值已经在 schema 里写过了。
 */
export function parseOrThrow<T>(schema: ZodType<T, ZodTypeDef, unknown>, input: unknown): T {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.join('.') ?? '';
    throw new BadRequestError(where ? `${where}: ${issue?.message}` : '参数不合法');
  }
  return result.data;
}

/** 会话摘要。`messageCount` 是**实时统计**，不是 Session 表里那个从未维护的列 */
export type SessionSummaryDTO = {
  id: string;
  kind: 'private' | 'group';
  peerId: string;
  peerName: string | null;
  lastActiveAt: string;
  messageCount: number;
  /** 人工接管：AI 不回，但消息照收 */
  aiPaused: boolean;
  reviewMode: boolean;
  muted: boolean;
  /** 最后一条消息的摘要；还没有消息时为 null（新建会话但没聊起来） */
  lastMessage: {
    role: string;
    content: string;
    senderName: string | null;
    createdAt: string;
  } | null;
};

/** 一条消息。**不含图片/语音的 URL**：那是协议端的临时链接，既会过期也不该在后台扩散 */
export type SessionMessageDTO = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  senderName: string | null;
  content: string;
  createdAt: string;
  /** 这条消息里出现过哪些媒体类型（image / voice / at / reply …），供界面显示成标签 */
  media: string[];
  /**
   * 内心独白（D036）：只有 assistant 且当时开了 think 才有。
   * 解析成结构再给前端 —— 让界面去 `JSON.parse` 一段库里的原始字符串，
   * 等于把"坏数据怎么办"推给了最不该负责的一层。
   */
  think: ThinkResult | null;
  blocked: boolean;
  blockReason: string | null;
};

export type MessagePageDTO = {
  items: SessionMessageDTO[];
  /** 还有更早的消息（界面据此显示"加载更早"） */
  hasMore: boolean;
};
