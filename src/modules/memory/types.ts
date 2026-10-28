/**
 * 记忆的类型（M5-1 / D045）。
 *
 * 只做两层，不做三层：
 *
 * ```
 * 会话窗口（D031，原文，几小时）→ 情节摘要（episodic，这次聊了什么）
 *                              → 语义事实（semantic，关于这个人的稳定事实）
 * ```
 *
 * "工作记忆"就是窗口本身 —— 它已经在 `Message` 表里、已经按预算裁剪过了，
 * 再存一份进记忆表只会得到两套不同步的真相。
 *
 * `subjectId` 一律是**平台内的对方 id**（D023：跨平台身份不合并）。
 */

export type MemoryScope = 'episodic' | 'semantic';

/** `summary` 只用于 episodic；其余三种用于 semantic */
export type MemoryKind = 'summary' | 'fact' | 'preference' | 'event';

/** 从库里读出来的一条记忆 */
export type MemoryRecord = {
  id: string;
  scope: MemoryScope;
  kind: string;
  content: string;
  importance: number;
  subjectId: string | null;
  sessionId: string | null;
  createdAt: Date;
};

/** 待写入的一条。`instanceId` 是归属（D023），不是"来源渠道" */
export type MemoryDraft = {
  instanceId: string;
  sessionId: string | null;
  subjectId: string | null;
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  importance: number;
  /** 溯源：这批记忆是从哪几条消息里总结出来的（最多留 20 个） */
  sourceMsgIds: string | null;
};

/**
 * 注入 prompt 的形态：**只有句子**。
 *
 * 不带 id、不带时间戳、不带 importance —— 模型拿这些没用，反而会学着在回复里
 * 提"根据我的记忆条目 #3"。要不要用、怎么提，是它自己按语气判断的事。
 */
export type PromptMemory = {
  /** 关于当前这个人的稳定事实（semantic），按重要度取前几条 */
  facts: string[];
  /** 这个会话最近的情节摘要（episodic），按时间先后 */
  summaries: string[];
};

export const EMPTY_MEMORY: PromptMemory = { facts: [], summaries: [] };
