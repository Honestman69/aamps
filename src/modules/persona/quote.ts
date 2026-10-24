/**
 * 「这条回复要不要引用上一条」（D030）。
 *
 * ## 为什么不让模型决定
 *
 * 1. 模型看不到时序与人数：它不知道目标是 3 秒前还是 3 小时前的，也不知道刚才有 2 个人在说话。
 *    而引用要解决的恰恰是这些问题 —— 让看不见问题的人判断要不要解决，只能靠猜。
 * 2. 引用是**结构化动作**（`replyToMessageId`），不是文本。让模型决定就得让它输出 message id，
 *    而它从没见过这些 id（全塞进 prompt 会吃掉大量 token 且诱导编造）。
 * 3. 同一 prompt 跑 10 次结果会波动，无法写测试；引用频率还是个连续倾向，模型表达不了。
 *
 * 还有一个反直觉的现象：模型有很强的**客服倾向**，只要给了"可以引用"的选项就会多用，
 * 结果一个"话少冷淡"的人格被演成客服。这不是方向错，是把性格抹平了。
 *
 * ## 所以拆成两条互不干扰的线
 *
 * | 线 | 判什么 | 谁判 | 性质 |
 * |---|---|---|---|
 * | 必要性 | 不引用会不会让人看不懂在回谁 | 本文件，硬判 | 可穷举、可测试 |
 * | 倾向性 | 不引用也不歧义，但这个人格爱不爱用 | `quoteTendency`，概率 | 只影响观感 |
 *
 * **必要性永不交给概率**。这样最坏情况只是"这个号今天少用了一次引用"（观感），
 * 绝不会"答非所问"（理解）。这就是"合适"的定义。
 *
 * ## 一条贯穿全文的判据
 *
 * **引用存在的意义是"目标不再是当前上下文的最新点"。** 如果目标就是最新一条，
 * 引用是纯冗余 —— 真人不会这么说话，只有客服机器人会。
 */

export const QUOTE_TENDENCIES = ['never', 'rare', 'normal', 'often'] as const;
export type QuoteTendency = (typeof QUOTE_TENDENCIES)[number];

export function isQuoteTendency(value: unknown): value is QuoteTendency {
  return typeof value === 'string' && (QUOTE_TENDENCIES as readonly string[]).includes(value);
}

/**
 * 从库里读出来的倾向，容错解析。
 *
 * 脏值（拼错、旧版本字段、被手工改坏）一律回落 `normal` 而不是抛错：
 * 人格数据坏了不能让机器人崩，更不能因此不发消息 —— 说得少点比不说话好。
 * 与 `parseFallbacks`（D026）同一套原则。
 */
export function parseQuoteTendency(value: unknown): QuoteTendency {
  return isQuoteTendency(value) ? value : 'normal';
}

/**
 * 倾向 → 中间地带引用概率。
 *
 * `never` 是 0 而不是很小的数：选它的人意思是"别主动引用"，
 * 但**必要引用仍会发生**（群聊里不引用就看不懂在回谁时，人格不能覆盖可理解性）。
 */
const TENDENCY_PROBABILITY: Record<QuoteTendency, number> = {
  never: 0,
  rare: 0.15,
  normal: 0.5,
  often: 0.85,
};

/** 群聊里目标消息超过这个时间就认为"上文滚走了" */
export const STALE_AFTER_MS = 60 * 1000;

/** 群聊里同一个人连发超过这个条数，回第一条时必须引用 */
export const MAX_GAP_WITHOUT_QUOTE = 5;

/** 私聊里对方连发达到这个条数（含目标本身），回最早那条时必须引用 */
export const PRIVATE_BURST_THRESHOLD = 3;

export type QuoteMessage = {
  id: string;
  senderId: string;
  createdAt: Date;
};

/**
 * 不引用的原因也要有名字。
 *
 * 只记"引用了"会让线上排查永远只能靠猜：明明没引用，却不知道是规则拦的、
 * 概率没过、还是压根没匹配到任何规则。
 */
export type QuoteReason =
  | 'direct_reply' // 对方引用了机器人，回复必须指向那句
  | 'multi_speaker' // 群聊里 target 之后有多人在说
  | 'stale' // 目标已经太久 / 隔了太多条
  | 'multi_message' // 私聊里对方连发，回的是其中一条
  | 'tendency' // 中间地带，人格倾向通过
  | 'redundant' // 目标就是最新一条，引用纯冗余
  | 'self_quote' // 目标是机器人自己说的
  | 'single_speaker'; // 群聊里只有一个人在连着说，不引用也清楚

export type QuoteDecision = {
  quote: boolean;
  reason: QuoteReason;
  /** 中间地带实际用的概率，便于解释"为什么这次没引用"；必要/禁止分支为 null */
  probability: number | null;
};

export type QuoteInput = {
  channel: 'private' | 'group';
  /** 机器人打算回复的那条消息 */
  target: QuoteMessage;
  /**
   * 窗口内 target **之后**的消息（时间升序）。
   *
   * 只传 target 之后的就够：判断"是不是最新一条""几个人在说""隔了几条"都只需要这段。
   * 传整个窗口反而会让调用方纠结"窗口多大"，而窗口大小不该影响这个判断。
   */
  after: readonly QuoteMessage[];
  /** 对方这条消息是否引用了机器人（direct reply） */
  incomingQuotesBot: boolean;
  /** 机器人自己的 userId（平台内标识），用于识别自引 */
  selfId: string;
  tendency: QuoteTendency;
  now: Date;
  /** 确定性随机的种子，默认 `target.id`；同一会话同一消息永远得到同一结果 */
  seed?: string;
};

export function decideQuote(input: QuoteInput): QuoteDecision {
  const { channel, target, after, incomingQuotesBot, selfId, tendency, now } = input;

  // ① 自引：回复自己刚说的话，引用框里是自己，观感很怪。对方真要问"你刚才说什么"，
  //    target 会是对方的提问消息，不会走到这里。
  if (target.senderId === selfId) {
    return { quote: false, reason: 'self_quote', probability: null };
  }

  // ② 对方明确引用了机器人：这是"回应某句"的语义，优先级最高 —— 连"紧邻冗余"都要让位
  if (incomingQuotesBot) {
    return { quote: true, reason: 'direct_reply', probability: null };
  }

  const isLatest = after.length === 0;

  if (channel === 'private') {
    // 私聊里目标就是最后一条：引用是纯冗余，一眼就是客服机器人
    if (isLatest) {
      return { quote: false, reason: 'redundant', probability: null };
    }

    // 对方连发（2 条以上在 target 之后 = 总共 3 条以上），回最早那条必须说明在回哪句
    if (after.length + 1 >= PRIVATE_BURST_THRESHOLD) {
      return { quote: true, reason: 'multi_message', probability: null };
    }

    // 只多了一条：引不引用都清楚，交给倾向
    return roll(input, tendency, 'tendency', 'redundant');
  }

  // ── 群聊 ──

  // 目标就是最新一条：哪怕刚才有几个人说话，上下文也在眼前
  if (isLatest) {
    return { quote: false, reason: 'redundant', probability: null };
  }

  const speakers = new Set(after.map((message) => message.senderId));
  if (speakers.size >= 2) {
    // 有多人在说，不引用根本不知道在回谁 —— 这是引用最主要的用途
    return { quote: true, reason: 'multi_speaker', probability: null };
  }

  const ageMs = now.getTime() - target.createdAt.getTime();
  if (ageMs > STALE_AFTER_MS) {
    return { quote: true, reason: 'stale', probability: null };
  }

  if (after.length > MAX_GAP_WITHOUT_QUOTE) {
    // 同一个人连着刷了太多条，回第一条必须指回
    return { quote: true, reason: 'stale', probability: null };
  }

  // 同一个人说了 1~5 条：不引用也清楚，交给倾向
  return roll(input, tendency, 'tendency', 'single_speaker');
}

function roll(
  input: QuoteInput,
  tendency: QuoteTendency,
  hitReason: QuoteReason,
  missReason: QuoteReason,
): QuoteDecision {
  const probability = TENDENCY_PROBABILITY[tendency];
  const seed = input.seed ?? input.target.id;
  const hit = stableRoll(seed) < probability;
  return { quote: hit, reason: hit ? hitReason : missReason, probability };
}

/**
 * 确定性伪随机：同一个种子永远得到同一个 [0,1) 值。
 *
 * 为什么不用 `Math.random`：那样同一个会话刷新两次结果不同，线上出问题无法复现，
 * 测试也只能写成"跑 100 次大约 50 次命中"这种不可靠断言。
 */
export function stableRoll(seed: string): number {
  let hash = 2166136261; // FNV-1a 32-bit
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 1000) / 1000;
}
