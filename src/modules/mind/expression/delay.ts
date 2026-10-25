/**
 * 打字延迟：让"发得多快"看起来像人（ARCHITECTURE 6.4）。
 *
 * ## 两条曲线
 *
 * - **首条前**：`0.8s + 字数 × 0.05s`，随机 ±30%。这段是"看到消息 + 读完 + 开始打字"，
 *   所以它跟**进来的那句话有多长**关系不大，跟"要回多少字"关系大 —— 用回复字数算，
 *   因为真人边读边想，读得快的人回得也快。
 * - **后续每条**：`字数 / 4.5 秒`（4.5 字/秒 ≈ 手机打字偏快的人）。这一段是纯打字时间。
 *
 * ## 两个系数
 *
 * 忙碌 ×3、深夜 ×1.6。**只乘不减**：任何"加速"都会让人更不像人，而这正是要避免的。
 *
 * ## 为什么要封顶
 *
 * 延迟是**同步等待**（后续要做每会话串行）。不封顶的话，模型偶尔输出 3000 字就能把
 * 一个会话卡住几十秒。`maxTotalMs` 是硬闸，超了就按比例压缩，而不是丢掉消息。
 */

export type DelayPolicy = {
  readBaseMs: number;
  readPerCharMs: number;
  /** 首条阅读时间的随机抖动比例（0.3 = ±30%） */
  readJitter: number;
  /** 打字速度：字/秒 */
  typingCps: number;
  busyFactor: number;
  nightFactor: number;
  /** 一张图片/一条语音前的停顿 */
  mediaDelayMs: number;
  /** 一次回复的延迟总和上限 */
  maxTotalMs: number;
};

export const DEFAULT_DELAY_POLICY: DelayPolicy = {
  readBaseMs: 800,
  readPerCharMs: 50,
  readJitter: 0.3,
  typingCps: 4.5,
  busyFactor: 3,
  nightFactor: 1.6,
  mediaDelayMs: 400,
  maxTotalMs: 12_000,
};

export type DelayContext = {
  busy: boolean;
  now: Date;
};

/** 深夜：23:00 ~ 07:00。与"夜间静默"不是同一件事：静默是不出声，这里是出声但慢 */
export function isLateNight(now: Date): boolean {
  const hour = now.getHours();
  return hour >= 23 || hour < 7;
}

function factor(ctx: DelayContext, policy: DelayPolicy): number {
  let multiplier = 1;
  if (ctx.busy) {
    multiplier *= policy.busyFactor;
  }
  if (isLateNight(ctx.now)) {
    multiplier *= policy.nightFactor;
  }
  return multiplier;
}

function clampDelay(ms: number): number {
  if (!Number.isFinite(ms)) {
    return 0;
  }
  return Math.min(30_000, Math.max(0, Math.round(ms)));
}

/** 首条消息前的"阅读 + 起手"时间 */
export function readDelayMs(
  chars: number,
  ctx: DelayContext,
  policy: DelayPolicy = DEFAULT_DELAY_POLICY,
  rand: () => number = () => 0.5,
): number {
  const base = policy.readBaseMs + Math.max(0, chars) * policy.readPerCharMs;
  // rand ∈ [0,1) → 抖动 ∈ [1-j, 1+j)
  const jitter = 1 - policy.readJitter + rand() * policy.readJitter * 2;
  return clampDelay(base * jitter * factor(ctx, policy));
}

/** 后续每条消息前的打字时间 */
export function typingDelayMs(
  chars: number,
  ctx: DelayContext,
  policy: DelayPolicy = DEFAULT_DELAY_POLICY,
): number {
  const cps = policy.typingCps > 0 ? policy.typingCps : 4.5;
  return clampDelay((Math.max(0, chars) / cps) * 1000 * factor(ctx, policy));
}

/**
 * 按总上限压缩一组延迟（保持相对比例）。
 *
 * 为什么压缩而不是丢弃：延迟是为了像人，丢消息是为了正确性。
 * 两者冲突时永远牺牲前者。
 */
export function clampTotalDelays(delays: readonly number[], maxTotalMs: number): number[] {
  const total = delays.reduce((sum, ms) => sum + Math.max(0, ms), 0);
  if (total <= maxTotalMs || total === 0) {
    return delays.map((ms) => Math.max(0, Math.round(ms)));
  }
  const ratio = maxTotalMs / total;
  return delays.map((ms) => Math.max(0, Math.round(ms * ratio)));
}
