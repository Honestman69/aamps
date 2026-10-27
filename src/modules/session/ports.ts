/**
 * 会话窗口的取数端口。
 *
 * 这一层的存在是因为 `buildWindow` 是纯函数，它假设"消息都在手里"。
 * 而真实取数有两条约束：
 *   1. **target 可能很老**，不在"最近 N 条"里 —— 所以必须按 target 定位，不能只取最近 N 条；
 *   2. **after 的总数可能很大**（群里刷了几百条），不能全拉进内存统计 —— count 与
 *      发言人数必须在数据库端算，否则窗口裁剪之后就再也算不准了。
 */

import type { WindowMessage } from './window';

export type WindowSlice = {
  target: WindowMessage;
  /** target 之前，时间升序 */
  before: WindowMessage[];
  /** target 之后，时间升序 */
  after: WindowMessage[];
  /** 基于**全量** after（不只是取出来的那部分） */
  afterTotals: { count: number; distinctSenders: number };
};

export interface ISessionWindowRepository {
  /**
   * 取 target 及其前后切片。
   *
   * @param beforeLimit 往前取多少条（建议给窗口 `maxMessages` 的 2 倍，让裁剪逻辑自己砍）
   * @param afterLimit  往后取多少条（同上）
   * @returns `null` 表示 target 不存在，或不属于该会话 —— 两种都不该继续回复
   */
  loadSlice(input: {
    sessionId: string;
    targetMessageId: string;
    beforeLimit: number;
    afterLimit: number;
  }): Promise<WindowSlice | null>;
}

// ─────────────────────────── 管理端只读（D043） ───────────────────────────
//
// 三个方法都带 `userId`：会话与消息没有 owner 列，归属要通过 `Session.instanceId → BotInstance.ownerUserId`
// 推出来。写成 `(userId, instanceId)` 而不是"查出来再判断"，是为了让拿别人的 id 只能得到空结果
// （AGENTS 硬性规则 5），而不是"查到之后再拦一次"。

/** 会话摘要行。`messageCount` 由调用方决定来源（见服务里的实时统计） */
export type SessionSummaryRow = {
  id: string;
  instanceId: string;
  kind: string;
  peerId: string;
  peerName: string | null;
  lastActiveAt: Date;
  /** **实时统计**（groupBy 算出来），不是 Session 表里那个从没被维护过的列 */
  messageCount: number;
  aiPaused: boolean;
  reviewMode: boolean;
  muted: boolean;
  lastMessage: {
    role: string;
    content: string;
    senderName: string | null;
    createdAt: Date;
  } | null;
};

export type SessionMessageRow = {
  id: string;
  role: string;
  senderName: string | null;
  content: string;
  createdAt: Date;
  /** 原始消息段（JSON 字符串）：只用来提取"有哪些媒体类型"，不把 URL 透出去 */
  segmentsJson: string;
  thinkJson: string | null;
  blocked: boolean;
  blockReason: string | null;
};

export interface ISessionAdminRepository {
  /** 实例是否存在且属于这个人。不存在就该 404，而不是"这个实例没有会话" */
  isInstanceOwned(userId: string, instanceId: string): Promise<boolean>;

  /** 按活跃时间倒序。**不分页**：先给 total，界面自己决定要不要提示"只看最近 N 个" */
  listForUser(userId: string, instanceId: string, limit: number): Promise<SessionSummaryRow[]>;

  countForUser(userId: string, instanceId: string): Promise<number>;

  /** 校验会话归属（跨会话/跨用户读消息必须先过这一关） */
  findSessionForUser(
    userId: string,
    sessionId: string,
  ): Promise<{ id: string; instanceId: string; kind: string; peerId: string; peerName: string | null } | null>;

  /**
   * 取一页消息，返回时**按时间升序**（界面直接渲染）。
   * `before` 是上一页最早那条的 id —— 见 `dto.ts` 里为什么不用时间戳做游标。
   */
  listMessages(input: {
    sessionId: string;
    limit: number;
    before?: string;
  }): Promise<{ rows: SessionMessageRow[]; hasMore: boolean }>;
}
