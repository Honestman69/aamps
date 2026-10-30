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
    /** 内心独白（D036）：只落库供排查，**不回灌给下一轮** */
    thinkJson?: string | null;
    /**
     * 这条是主动发的（M5-3 / D047）。
     *
     * 单独一列而不是靠"没有入站消息"去推断：推断出来的东西没法索引，
     * 而"今天主动了几次"是每次心跳都要问的。
     */
    proactive?: boolean;
    /**
     * 这条被规则拦了（D051）。**仍然落库**：会话查看里要能看到"它本来想说什么"，
     * 这是排查"它怎么不回我"最直接的一条证据。
     */
    blocked?: boolean;
    /** `rule:<id>` | moderation | owner */
    blockReason?: string | null;
  }): Promise<StoredMessage>;

  /**
   * 把一条**已入库**的消息标成被拦（D051）。
   *
   * 入站消息在第 ① 步就落库了，等规则命中时它已经在库里 —— 所以这里只是补个标记，
   * 不是再插一条。标记的意义是：会话查看里能看出"这条被规则拦了，不是它没看见"。
   */
  markBlocked(messageId: string, reason: string): Promise<void>;
}
