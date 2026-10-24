/**
 * 会话与消息持久化端口（Pipeline 用）。
 *
 * 与 `window.ts` / `ISessionWindowRepository` 的分工：
 *   - 这里负责**写**：入站/出站消息落库、会话 upsert；
 *   - 窗口仓储负责**读**：取 target 前后切片 + 全量统计。
 * 写读分离，避免一条消息既要落库、又要读回自己。
 */

import type { InboundMessage } from '@newjob/contracts';

export type SessionRecord = {
  id: string;
  instanceId: string;
  kind: string;
  peerId: string;
  /** 群名 / 对方昵称，展示用 */
  peerName: string | null;
};

/** 落库后的消息（含数据库生成的 id 与时间） */
export type StoredMessage = {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  senderId: string | null;
  content: string;
  createdAt: Date;
};

export interface ISessionRepository {
  /**
   * 找到或创建会话。
   *
   * 依赖 `@@unique([instanceId, kind, peerId])`，用 upsert 而非 find-then-create：
   * 两个并发消息同时第一次落到同一个会话时，find-then-create 会撞唯一键。
   */
  ensureSession(input: {
    instanceId: string;
    kind: string;
    peerId: string;
    peerName?: string | null;
  }): Promise<SessionRecord>;

  /** 入站消息落库。senderId 取 sender.id（平台内用户 id） */
  saveInbound(input: {
    sessionId: string;
    message: InboundMessage;
  }): Promise<StoredMessage>;

  /** 出站消息落库（assistant 回复）。senderId 传 null 或机器人自己的 id 由调用方定 */
  saveOutbound(input: {
    sessionId: string;
    content: string;
    senderId: string | null;
    /** 回复的是哪条消息（引用），可空 */
    replyToMessageId?: string | null;
  }): Promise<StoredMessage>;
}
