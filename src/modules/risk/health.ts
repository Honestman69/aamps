/**
 * 实例健康分的**纯函数**（M6-1 / D048）。
 *
 * ## 为什么要有分数
 *
 * 第三方协议的风控是"渐进式"的：先静默，再拦发送，再限制登录态，最后封号。
 * 如果只在被封那天才发现，前面所有信号都白丢了。所以要把"最近发生了什么"
 * 压成一个 0-100 的数，并且**按阶梯自动退让** —— 人不会 24 小时盯着看板。
 *
 * ## 分数是给人看的，阶梯是给机器执行的
 *
 * 两者刻意分开：
 *   - `assessHealth` 只算分数与理由（纯函数，输入是信号列表，能穷举测试）；
 *   - `planDegradation` 只按"连续被拦了几次"给动作（不做加权、不做猜测）。
 *
 * 混在一起的后果是：分数一抖动就降级，或者降级了但说不清为什么。
 *
 * ## 为什么不把"发送失败率"算进去
 *
 * 失败率需要"总发送次数 vs 失败次数"，而失败在网关与适配器两层都可能发生，
 * 且 `ModelUsage` 只记模型调用、不记发送。用一个口径不清的比率参与评分，
 * 会让分数在"模型欠费"和"平台拦截"之间乱跳 —— 那两件事的应对方式完全不同。
 */

export type RiskSignalLevel = 'info' | 'warn' | 'error' | 'risk' | string;

export type RiskSignal = {
  code: string;
  level: RiskSignalLevel;
  createdAt: Date;
};

export type HealthLevel = 'healthy' | 'degraded' | 'readonly' | 'stopped';

export type HealthResult = {
  score: number;
  level: HealthLevel;
  /** 人读的理由（写进看板与审计，"为什么 62 分"要能回答） */
  reasons: string[];
  /** 连续被平台拦截的次数（从最近一条往前数，遇到非拦截信号就停） */
  consecutiveBlocks: number;
};

export const HEALTH_LIMITS = {
  /** 只看最近 24 小时的信号 */
  windowHours: 24,
  /** 每条 send_blocked 扣多少 */
  blockPenalty: 25,
  /** 拦截扣分上限（再多的拦截也不会把分数扣穿，剩下的交给 ledger） */
  blockPenaltyCap: 60,
  /** 掉线/登录态异常每条扣多少 */
  offlinePenalty: 10,
  offlinePenaltyCap: 30,
  /** 实例状态本身是 risk/banned 时的额外扣分 */
  statusPenalty: { risk: 20, banned: 100 } as Record<string, number>,
  /**
   * 等级分界（含边界，"50 分"就算 readonly）。
   *
   * 与阶梯对齐：2 次拦截 = 50 分 = readonly，1 次 = 75 分 = degraded。
   * 这两个数字必须能对上 —— 否则看板写"degraded"、机器却在 readonly，人会怀疑哪个是真的。
   */
  thresholds: { degraded: 80, readonly: 50, stopped: 20 },
} as const;

/** 视为"被平台拦了"的信号：只有这几条能推动降级阶梯 */
const BLOCK_CODES = new Set(['send_blocked', 'rate_limited']);
/** 视为"连接不稳"的信号 */
const OFFLINE_CODES = new Set(['login_lost', 'offline', 'connect_failed']);

function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 3600_000;
}

/** 从最近往前数连续拦截次数。中间夹一条发送成功（info）就清零。 */
function countConsecutiveBlocks(signals: RiskSignal[]): number {
  let count = 0;
  for (const signal of signals) {
    if (BLOCK_CODES.has(signal.code)) {
      count += 1;
      continue;
    }
    // `info` 级的成功发送会打断"连续"；其余信号（掉线等）不打断，也不累加
    if (signal.level === 'info') {
      break;
    }
  }
  return count;
}

/**
 * 算健康分。窗口外的信号直接丢掉（不让一个月前的一次拦截永远压着分数）。
 *
 * `signals` 必须是**按时间倒序**（最新在前）—— 连续拦截的判定依赖顺序，
 * 排序放在仓储里做（SQL `order by createdAt desc`），这里只做纯计算。
 */
export function assessHealth(input: {
  status: string;
  signals: RiskSignal[];
  now: Date;
}): HealthResult {
  const reasons: string[] = [];
  let score = 100;

  const windowStart = new Date(input.now.getTime() - HEALTH_LIMITS.windowHours * 3600_000);
  const signals = input.signals.filter((signal) => signal.createdAt >= windowStart);

  const blocks = signals.filter((signal) => BLOCK_CODES.has(signal.code)).length;
  if (blocks > 0) {
    const penalty = Math.min(HEALTH_LIMITS.blockPenaltyCap, blocks * HEALTH_LIMITS.blockPenalty);
    score -= penalty;
    reasons.push(`${HEALTH_LIMITS.windowHours} 小时内被拦截 ${blocks} 次（-${penalty}）`);
  }

  const offlines = signals.filter((signal) => OFFLINE_CODES.has(signal.code)).length;
  if (offlines > 0) {
    const penalty = Math.min(HEALTH_LIMITS.offlinePenaltyCap, offlines * HEALTH_LIMITS.offlinePenalty);
    score -= penalty;
    reasons.push(`${HEALTH_LIMITS.windowHours} 小时内掉线/登录异常 ${offlines} 次（-${penalty}）`);
  }

  const statusPenalty = HEALTH_LIMITS.statusPenalty[input.status] ?? 0;
  if (statusPenalty > 0) {
    score -= statusPenalty;
    reasons.push(`实例状态为 ${input.status}（-${statusPenalty}）`);
  }

  const consecutiveBlocks = countConsecutiveBlocks(signals);
  if (consecutiveBlocks >= 2) {
    reasons.push(`连续被拦截 ${consecutiveBlocks} 次`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let level: HealthLevel = 'healthy';
  if (input.status === 'banned') {
    level = 'stopped';
  } else if (score <= HEALTH_LIMITS.thresholds.stopped) {
    level = 'stopped';
  } else if (score <= HEALTH_LIMITS.thresholds.readonly) {
    level = 'readonly';
  } else if (score <= HEALTH_LIMITS.thresholds.degraded) {
    level = 'degraded';
  }

  if (reasons.length === 0) {
    reasons.push('无异常信号');
  }

  return { score, level, reasons, consecutiveBlocks };
}

export type DegradeAction =
  | { kind: 'none' }
  /** 冷却：静默一段时间，连接保留 */
  | { kind: 'cooldown'; until: Date; reason: string }
  /** 只收不发：静默很久 + 状态标 risk（连接保留，人能看到） */
  | { kind: 'readonly'; until: Date; reason: string }
  /** 停实例：enabled=false + status=banned，等人工介入 */
  | { kind: 'stop'; reason: string };

export const DEGRADE_LIMITS = {
  /** 第 1 次连续拦截：冷却 10 分钟（ARCHITECTURE 7.3） */
  cooldownMinutes: 10,
  /** 第 2 次：只收不发 6 小时（原文没给时长，取"够人看到但不至于废掉一整天"） */
  readonlyHours: 6,
  /** 第 3 次起：停实例 */
  stopAt: 3,
} as const;

/**
 * 降级阶梯：只看"连续被拦了几次"，不看分数。
 *
 * 分数的用途是**给人看**（趋势、看板），阶梯的用途是**给机器执行**。
 * 用分数驱动降级的话，"掉线太多"也会导致停实例 —— 而掉线该做的是重连退避，不是停。
 *
 * 阶梯只升不降：`currentSilentUntil` 比本次算出来的更晚时，保留更晚的那个
 * （不要因为又算了一次就把 6 小时的静默缩短成 10 分钟）。
 */
export function planDegradation(input: {
  consecutiveBlocks: number;
  now: Date;
  currentSilentUntil: Date | null;
}): DegradeAction {
  const later = (candidate: Date): Date =>
    input.currentSilentUntil && input.currentSilentUntil > candidate
      ? input.currentSilentUntil
      : candidate;

  if (input.consecutiveBlocks <= 0) {
    return { kind: 'none' };
  }

  if (input.consecutiveBlocks >= DEGRADE_LIMITS.stopAt) {
    return {
      kind: 'stop',
      reason: `连续被拦截 ${input.consecutiveBlocks} 次，停止实例等人工介入`,
    };
  }

  if (input.consecutiveBlocks === 2) {
    return {
      kind: 'readonly',
      until: later(new Date(input.now.getTime() + DEGRADE_LIMITS.readonlyHours * 3600_000)),
      reason: '连续被拦截 2 次：只收不发',
    };
  }

  return {
    kind: 'cooldown',
    until: later(new Date(input.now.getTime() + DEGRADE_LIMITS.cooldownMinutes * 60_000)),
    reason: '被拦截 1 次：冷却 10 分钟',
  };
}
