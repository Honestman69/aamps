/**
 * 心智瞬态：mood（情绪）/ energy（精力）的衰减与交互影响（M3-1）。
 *
 * ## 为什么是纯函数
 *
 * 衰减规则里最容易错的是"到底衰减了多少"：漏算、重复算、时钟回拨算成负数。
 * 这些都是**数学问题**，不该等到接上数据库才发现。所以这里只做 `(state, now) → state`，
 * 数据库读写在 `ports.ts` 后面，测试里给两个时间点就能穷举。
 *
 * ## 三条规则
 *
 * 1. **不重复衰减**：衰减量始终由 `lastDecayAt → now` 的间隔决定，返回值的
 *    `lastDecayAt` 同步推进到 `now`。上层写库后，下一次衰减自然从新的起点算起。
 *    如果状态没被写回（比如消息被治理拦掉），下次会从更早的起点重算——结果一样，不会叠加。
 * 2. **时钟回拨不衰减**：`now <= lastDecayAt` 时原样返回，连 `lastDecayAt` 都不动。
 *    时间倒退时"补衰减"毫无意义，而把起点提前会吞掉真实经过的时间。
 * 3. **精力往作息曲线回归，不是自由漂移**：`energy` 不会自己涨也不会自己掉到底，
 *    它按点收敛到当地时刻的基线（深夜低、午后低谷）。所以"人累了"和"人缓过来了"
 *    都是同一条曲线，不需要额外的事件去"恢复"。
 *
 * ## 刻意没做的
 *
 * - **mood 没有推动来源**：情绪的推动量来自内心独白阶段（M3-4 的 `emotion_shift`）。
 *   现在只有"回归基线"，因为凭消息文本猜情绪等于瞎猜，猜错了比不动更糟。
 * - 不做 `busy` 的自动设置：`busyUntil` 由人（或 M5 的主动消息任务）写，
 *   这里只负责判定与过期清理。
 */

export type MindState = {
  /** -1 ~ 1，负 = 烦躁/低落，正 = 愉快 */
  mood: number;
  /** 0 ~ 1 */
  energy: number;
  /** 忙到什么时候；过期后由 `decayState` 清空 */
  busyUntil: Date | null;
  /** 上次衰减的起点 */
  lastDecayAt: Date;
};

export const MOOD_RANGE = { min: -1, max: 1 } as const;
export const ENERGY_RANGE = { min: 0, max: 1 } as const;

export const DEFAULT_ENERGY = 0.8;
export const DEFAULT_MOOD = 0;

/** 每小时向基线（0）回归 8%（ARCHITECTURE 6.1） */
export const MOOD_REGRESSION_PER_HOUR = 0.08;

/**
 * 精力的收敛时间常数（小时）。
 *
 * 2.5 小时意味着：隔了 2.5 小时没说话，精力走完约 63% 的差距；
 * 隔 6 小时基本完全回到曲线。取值偏"钝"是刻意的——精力曲线变化太快会让人
 * 每十分钟换一种状态，看起来像人格不稳定。
 */
export const ENERGY_RELAX_TAU_HOURS = 2.5;

/** 回一条消息的精力成本。数值很小：聊一晚上才会明显掉，不是聊两句就困 */
export const REPLY_ENERGY_COST = 0.02;

/**
 * 作息曲线（当地小时 → 基线精力）。
 *
 * 0 点 0.55 说明"还没困死"，因为现代人 0 点还在刷手机；3 点掉到 0.40；
 * 7 点开始恢复；13~14 点午后低谷；20 点前后最高。
 * 中间用线性插值，不追求平滑——曲线的作用是"趋势像人"，不是精确拟合。
 */
export const ENERGY_CURVE: ReadonlyArray<readonly [hour: number, energy: number]> = [
  [0, 0.55],
  [3, 0.4],
  [6, 0.45],
  [7, 0.62],
  [9, 0.88],
  [12, 0.9],
  [13, 0.72],
  [14, 0.7],
  [16, 0.85],
  [20, 0.88],
  [22, 0.7],
  [24, 0.58],
];

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

export function clampMood(value: number): number {
  return clamp(value, MOOD_RANGE.min, MOOD_RANGE.max);
}

export function clampEnergy(value: number): number {
  return clamp(value, ENERGY_RANGE.min, ENERGY_RANGE.max);
}

/** 新建状态：没有历史，精力取默认值，衰减起点为现在 */
export function createMindState(now: Date, overrides: Partial<MindState> = {}): MindState {
  return {
    mood: clampMood(overrides.mood ?? DEFAULT_MOOD),
    energy: clampEnergy(overrides.energy ?? DEFAULT_ENERGY),
    busyUntil: overrides.busyUntil ?? null,
    lastDecayAt: overrides.lastDecayAt ?? now,
  };
}

/** 当地小时（含分钟的小数）。用服务器本地时区，与预算/限频的"一天"口径一致 */
export function localHour(now: Date): number {
  return now.getHours() + now.getMinutes() / 60;
}

/** 按作息曲线取某个时刻的基线精力 */
export function energyBaseline(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  const first = ENERGY_CURVE[0] as readonly [number, number];
  if (h <= first[0]) {
    return first[1];
  }
  for (let i = 1; i < ENERGY_CURVE.length; i += 1) {
    const [h1, v1] = ENERGY_CURVE[i] as readonly [number, number];
    const [h0, v0] = ENERGY_CURVE[i - 1] as readonly [number, number];
    if (h <= h1) {
      const ratio = h1 === h0 ? 0 : (h - h0) / (h1 - h0);
      return v0 + (v1 - v0) * ratio;
    }
  }
  const last = ENERGY_CURVE[ENERGY_CURVE.length - 1] as readonly [number, number];
  return last[1];
}

export function isBusy(state: MindState, now: Date): boolean {
  return state.busyUntil !== null && state.busyUntil.getTime() > now.getTime();
}

/**
 * 把状态推进到 `now`。
 *
 * 只做三件事：情绪回归、精力向曲线收敛、过期的 `busyUntil` 清空。
 */
export function decayState(state: MindState, now: Date): MindState {
  const elapsedMs = now.getTime() - state.lastDecayAt.getTime();
  if (elapsedMs <= 0) {
    // 时钟回拨或同毫秒重复调用：不衰减，也不推进起点。
    // 但 `busyUntil` 是否过期是"此刻的事实"，与有没有经过时间无关，照常清理。
    return { ...state, busyUntil: expireBusy(state.busyUntil, now) };
  }

  const hours = elapsedMs / 3_600_000;
  const mood = clampMood(state.mood * Math.pow(1 - MOOD_REGRESSION_PER_HOUR, hours));

  const baseline = energyBaseline(localHour(now));
  const relax = 1 - Math.exp(-hours / ENERGY_RELAX_TAU_HOURS);
  const energy = clampEnergy(state.energy + (baseline - state.energy) * relax);

  return { mood, energy, busyUntil: expireBusy(state.busyUntil, now), lastDecayAt: now };
}

function expireBusy(busyUntil: Date | null, now: Date): Date | null {
  return busyUntil && busyUntil.getTime() > now.getTime() ? busyUntil : null;
}

/**
 * 交互影响：回一条消息要花精力，情绪可被当轮对话推动。
 *
 * `moodShift` 当前只有 M3-4 的内心独白能给（`emotion_shift`），传 0 表示"这一轮无所谓"。
 */
export function applyReply(
  state: MindState,
  options: { energyCost?: number; moodShift?: number } = {},
): MindState {
  const energyCost = options.energyCost ?? REPLY_ENERGY_COST;
  const moodShift = options.moodShift ?? 0;
  return {
    ...state,
    mood: clampMood(state.mood + moodShift),
    energy: clampEnergy(state.energy - energyCost),
  };
}
