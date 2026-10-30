/**
 * 出站节流的**纯函数**（M6-2 / D049）。
 *
 * 四条规则都来自 ARCHITECTURE 7.1，它们的共同点是"平台会因为这个封号"，
 * 而它们的区别是"封的是哪种行为"：
 *
 * | 规则 | 防的是什么 |
 * |---|---|
 * | 单会话每小时 40 条 | 在一个群里刷屏（最容易被群友举报） |
 * | 单实例每天 800 条 | 全天候批量行为（平台的日活异常检测） |
 * | 连续 5 条后冷却 30s | "一个人连着说十句" —— 真人会停，机器不会 |
 * | 24h 内同内容 >3 次 | 复读机判定（同一条文本反复发是最大的机器特征） |
 *
 * ## 为什么"超限"是静默而不是排队
 *
 * 排队意味着"半小时后把那句话补发出去"。对聊天来说这是灾难：
 * 半小时前的"哈哈"现在发出来只会莫名其妙。**超限就这一次不说**，
 * 消息已经入库，人能看到它本来想说什么。
 *
 * 唯一会等的是"连续 5 条之后的 30 秒冷却" —— 那是同一段回复里的节奏问题，
 * 等 30 秒再发仍然成立（真人也是一句一句打的）。
 */

export const OUTBOUND_LIMITS = {
  /** 单个会话每小时最多发几条 */
  perSessionPerHour: 40,
  /** 单实例每天最多发几条（会被配置里的 `dailyMsgCap` 覆盖） */
  perInstancePerDay: 800,
  /** 连续发几条之后必须停一下 */
  consecutiveBeforeCooldown: 5,
  /** 停多久（毫秒） */
  cooldownMs: 30_000,
  /** 相似内容的比较窗口 */
  similarWindowHours: 24,
  /** 窗口内同一内容最多出现几次（超过就拦） */
  similarMax: 3,
  /** 归一化后短于这个长度的内容不参与相似判定（"嗯""好"本来就会重复） */
  similarMinChars: 4,
} as const;

export type OutboundRecent = {
  /** 该会话最近一小时的出站条数 */
  sessionLastHour: number;
  /** 该实例今天的出站条数 */
  instanceToday: number;
  /** 从最新往回数，连续多少条是它自己说的（遇到对方说话就停） */
  consecutive: number;
  /** 该会话最近一次出站时间 */
  lastOutboundAt: Date | null;
  /** 24 小时内与该文本"相似"的条数 */
  similarCount: number;
};

export type OutboundRejectReason = 'session-hour-limit' | 'instance-day-limit' | 'similar-content';

export type OutboundDecision =
  | { allow: true; waitMs: number }
  | { allow: false; reason: OutboundRejectReason };

/**
 * 归一化：去掉空白、标点、表情符号的差异，只留字。
 *
 * "在吗？"、"在吗"、"在吗！" 在平台眼里是同一条内容 —— 判定也要这么看，
 * 否则稍微改个标点就绕过了防复读机。
 */
export function normalizeOutboundText(text: string): string {
  return text
    .toLowerCase()
    // 空白 + 中英文标点 + 常见全角符号
    .replace(/[\s，。、！？；：,.!?;:"'“”‘’（）()【】「」『』《》〈〉\[\]{}…~～\-—_*#@/\\|]+/g, '')
    // 表情/emoji 一律视作噪声（它们的码位分散，用代理对区间粗筛足够）
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .trim();
}

/** 24h 窗口里"和这句话算同一条"的条数 */
export function countSimilar(
  outbound: Array<{ content: string }>,
  text: string,
  limits = OUTBOUND_LIMITS,
): number {
  const target = normalizeOutboundText(text);
  if (target.length < limits.similarMinChars) {
    return 0;
  }
  let count = 0;
  for (const item of outbound) {
    if (normalizeOutboundText(item.content) === target) {
      count += 1;
    }
  }
  return count;
}

/**
 * 连续条数：从最新往回数，遇到对方（`user`）就停。
 *
 * 为什么不用"30 秒内有几条"来判断：真人可以一分钟说三句（不连续也一样），
 * 也可以隔十秒说一句说十句（这才是刷屏）。判据应该是**对方有没有插话**。
 */
export function countConsecutive(messages: Array<{ role: string }>): number {
  let count = 0;
  for (const message of messages) {
    if (message.role !== 'assistant') {
      break;
    }
    count += 1;
  }
  return count;
}

/**
 * 现在能不能发。
 *
 * 检查顺序即优先级：日上限 → 会话小时上限 → 相似内容 → 连续冷却。
 * 前三者是"这次不发"，最后一条是"等一会儿再发"。
 */
export function decideOutbound(input: {
  now: Date;
  recent: OutboundRecent;
  /** 配置里的每日上限（`0` = 不限，与 D024 的预算口径一致） */
  dailyCap?: number;
  limits?: typeof OUTBOUND_LIMITS;
}): OutboundDecision {
  const limits = input.limits ?? OUTBOUND_LIMITS;
  const dailyCap = input.dailyCap && input.dailyCap > 0 ? input.dailyCap : limits.perInstancePerDay;

  if (input.recent.instanceToday >= dailyCap) {
    return { allow: false, reason: 'instance-day-limit' };
  }

  if (input.recent.sessionLastHour >= limits.perSessionPerHour) {
    return { allow: false, reason: 'session-hour-limit' };
  }

  if (input.recent.similarCount >= limits.similarMax) {
    return { allow: false, reason: 'similar-content' };
  }

  if (
    input.recent.consecutive >= limits.consecutiveBeforeCooldown &&
    input.recent.lastOutboundAt
  ) {
    const elapsed = input.now.getTime() - input.recent.lastOutboundAt.getTime();
    const remain = limits.cooldownMs - elapsed;
    if (remain > 0) {
      return { allow: true, waitMs: remain };
    }
  }

  return { allow: true, waitMs: 0 };
}
