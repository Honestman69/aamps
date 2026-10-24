/**
 * 会话窗口：一次推理要带多少上下文（D031）。
 *
 * ## 为什么不能"取最近 N 条"就完事
 *
 * 群聊里最常见的情况是：**你回复的那条早就不在最近 N 条里了**。
 * 群里刷了 50 条，机器人回的是第 3 条 —— 只取最近 20 条，模型根本不知道在回什么，
 * 只能瞎猜或者答非所问。所以窗口的第一条规则是：
 *
 * > **被回复的那条（target）必须在窗口里，哪怕它已经很老。**
 *
 * ## 三重约束，各管一件事
 *
 * | 约束 | 管什么 | 失控后果 |
 * |---|---|---|
 * | `maxMessages` | 硬上限 | 刷屏时一次拉几百条 |
 * | `maxAgeMs` | 语义边界 | 把三小时前另一个话题拉进来 |
 * | `maxChars` | 预算（真正卡 token 的） | 长文把上下文吃光 |
 *
 * 三者取**交集**：任何一条触发就停。
 *
 * ## 裁剪顺序是一条不对等的规则
 *
 * `after`（target 之后的消息）**优先保留、不按时间裁**，`before` 先被裁。
 * 理由：`after` 是"我回的这条之后又发生了什么"，是回应的直接语境；
 * `before` 只是背景。缺背景还能聊，缺直接语境（对方刚补了一句"不是那个意思"）就答歪了。
 */

import type { QuoteMessage } from '../persona/quote';

export type WindowMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  /** 平台内发言人 id；assistant 消息可能是机器人自己的 id */
  senderId: string | null;
  /** 群聊里必须带，否则模型分不清谁说的（私聊可以没有） */
  senderName: string | null;
  content: string;
  createdAt: Date;
};

export type WindowLimits = {
  /** 总条数上限，含 target */
  maxMessages: number;
  /** `before` 的时间边界；超过就不再看（target 与 after 不受此限） */
  maxAgeMs: number;
  /** 总字符预算，含 target。中文约 1 字 1.3 token，按字符算比按行算稳 */
  maxChars: number;
};

/**
 * 默认预算。
 *
 * 私聊 20 条 ≈ 10 轮对话；群聊 40 条是因为人多、同样时间跨度消息更多。
 * 字符预算给得比"平均情况"宽松：真正触发它的是长文，而长文恰恰最需要被限制。
 */
export const DEFAULT_WINDOW_LIMITS: Record<'private' | 'group', WindowLimits> = {
  private: { maxMessages: 20, maxAgeMs: 2 * 60 * 60 * 1000, maxChars: 4000 },
  group: { maxMessages: 40, maxAgeMs: 2 * 60 * 60 * 1000, maxChars: 6000 },
};

export type ContextWindow = {
  /** 被回复的那条，一定存在 */
  target: WindowMessage;
  /** target 之前的上下文（时间升序，可能为空） */
  before: WindowMessage[];
  /** target 之后的消息（时间升序，超预算时裁掉的是**最老的**） */
  after: WindowMessage[];
  /**
   * 基于**未裁剪**的 after 统计。
   *
   * 引用决策要用它而不是 `after.length`：群里刷了 200 条时窗口只会留下几十条，
   * 若按裁剪后的条数判断"隔了几条 / 几个人在说"，结论会完全错。
   */
  afterTotals: { count: number; distinctSenders: number; lastAt: Date | null };
  /** 被丢掉的条数，用于日志与"上下文被截断"的可见性 */
  dropped: { before: number; after: number };
};

/**
 * 组装窗口。
 *
 * @param messages 该会话的消息，**时间升序**。取数时只做粗过滤（例如最近 24 小时），
 *                 精细裁剪交给这里 —— 这样裁剪逻辑只有一处，可以被穷举测试。
 * @returns `null` 表示 target 不在 messages 里（消息被删了，或传错了会话）。
 *          调用方应当放弃这次回复，而不是拿别的消息硬凑。
 */
export function buildWindow(input: {
  targetId: string;
  messages: readonly WindowMessage[];
  limits: WindowLimits;
  now: Date;
}): ContextWindow | null {
  const { targetId, messages, limits, now } = input;

  const targetIndex = messages.findIndex((message) => message.id === targetId);
  if (targetIndex < 0) {
    return null;
  }

  const target = messages[targetIndex] as WindowMessage;
  const afterAll = messages.slice(targetIndex + 1);
  const beforeAll = messages.slice(0, targetIndex);

  const afterTotals = {
    count: afterAll.length,
    distinctSenders: new Set(afterAll.map((message) => message.senderId ?? '?')).size,
    lastAt: afterAll.length > 0 ? (afterAll[afterAll.length - 1]?.createdAt ?? null) : null,
  };

  // 预算先扣掉 target 自己：它没有讨论余地，必须留
  let remainingMessages = Math.max(0, limits.maxMessages - 1);
  let remainingChars = Math.max(0, limits.maxChars - target.content.length);

  // ① after 从**尾**往前取（最近的最重要），不按时间裁
  const after: WindowMessage[] = [];
  for (let i = afterAll.length - 1; i >= 0 && remainingMessages > 0; i -= 1) {
    const message = afterAll[i] as WindowMessage;
    if (message.content.length > remainingChars) {
      break;
    }
    after.unshift(message);
    remainingMessages -= 1;
    remainingChars -= message.content.length;
  }

  // ② before 从尾往前取，受时间边界约束
  //
  // 用 break 而不是 continue：一旦超预算就整体停下，不去"跳过大消息取小消息"。
  // 那样会在上下文里挖洞 —— 比少给一段更糟，模型会把不连续的两段当成连续对话。
  const ageLimit = now.getTime() - limits.maxAgeMs;
  const before: WindowMessage[] = [];
  for (let i = beforeAll.length - 1; i >= 0 && remainingMessages > 0; i -= 1) {
    const message = beforeAll[i] as WindowMessage;
    if (message.createdAt.getTime() < ageLimit) {
      break;
    }
    if (message.content.length > remainingChars) {
      break;
    }
    before.unshift(message);
    remainingMessages -= 1;
    remainingChars -= message.content.length;
  }

  return {
    target,
    before,
    after,
    afterTotals,
    dropped: {
      before: beforeAll.length - before.length,
      after: afterAll.length - after.length,
    },
  };
}

/** 窗口里的消息按时间顺序铺平（target 在中间），拼 prompt 时用 */
export function flattenWindow(window: ContextWindow): WindowMessage[] {
  return [...window.before, window.target, ...window.after];
}

/**
 * 转成引用决策需要的形状。
 *
 * `afterTotals` 用未裁剪的统计，其余字段来自窗口 —— 这是窗口与引用决策的接缝，
 * 放在这里而不是让调用方自己拼，避免两边对"after 到底该用哪个"理解不一致。
 */
export function windowQuoteFacts(window: ContextWindow): {
  target: QuoteMessage;
  after: QuoteMessage[];
  afterTotals: { count: number; distinctSenders: number };
} {
  return {
    target: {
      id: window.target.id,
      senderId: window.target.senderId ?? '?',
      createdAt: window.target.createdAt,
    },
    after: window.after.map((message) => ({
      id: message.id,
      senderId: message.senderId ?? '?',
      createdAt: message.createdAt,
    })),
    afterTotals: {
      count: window.afterTotals.count,
      distinctSenders: window.afterTotals.distinctSenders,
    },
  };
}
