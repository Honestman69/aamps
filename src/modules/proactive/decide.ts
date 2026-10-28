/**
 * 主动消息的**代码闸门**（M5-3 / D047）。
 *
 * 主动开口是这套系统里**唯一由机器发起**的动作，所以它比别的功能更需要"先说不"。
 * 这里的判据全部是确定性的，一条模型判断都不参与 —— 理由和引用决策一样（D030）：
 * 模型看不到时序、配额、对方多久没说话，让它决定"该不该发"只会得到客服式的积极性。
 *
 * ## 只做三个触发条件里的一个
 *
 * ARCHITECTURE 6.5 写了三个：未完结话题 / 亲密的人久了没说话 / 纪念日。
 * 这一版只做第二个 —— 它不需要语义判断，能被穷举测试。
 * 另外两个（"等会儿""明天"这类时间线索、记忆里的纪念日）要读消息与记忆做语义提取，
 * 做不对的代价是**凭空编一件事**去开场，比沉默糟得多。留给之后。
 *
 * ## 五道闸，顺序即优先级
 *
 * | 闸 | 值 | 防什么 |
 * |---|---|---|
 * | 开关 | 默认关 | 没人打开时一行代码都不跑 |
 * | 夜间静默 | 23:00–08:00 | 半夜发消息是所有"机器味"里最刺眼的一种 |
 * | 亲密度 | ≥ 40 | 对刚认识的人主动，是骚扰 |
 * | 久未联系 | ≥ 48h | 人家刚说完话，不需要"被想起来" |
 * | 冷却 | 同一人 ≥ 72h、同一实例每天 ≤ 3 | 对方不回时，隔天再敲一次就是烦人 |
 *
 * 数字写死在代码里（同 D020 的演化闸门）：先给一个开关，不给八个旋钮。
 * 一个人调八个参数，最后一定是把每天的限频调到最大、然后被平台封号。
 */

export const PROACTIVE_LIMITS = {
  /** 多久没说话才算"久了" */
  minIdleHours: 48,
  /** 亲密度门槛（0-100，见 `Relationship.affinity`） */
  minAffinity: 40,
  /** 同一个人两次主动之间至少隔多久（对方不回就别追） */
  peerCooldownHours: 72,
  /** 同一实例每天最多主动几条（平台风控红线） */
  perInstancePerDay: 3,
  /** 夜间静默：这段时间内不发（本地时区） */
  quietStartHour: 23,
  quietEndHour: 8,
} as const;

export type ProactiveRejectReason =
  | 'disabled'
  | 'quiet-hours'
  | 'never-talked'
  | 'not-close-enough'
  | 'too-soon'
  | 'peer-cooldown'
  | 'instance-cap';

export type ProactiveDecision =
  | { speak: true; reason: 'idle-close-friend'; idleHours: number }
  | { speak: false; reason: ProactiveRejectReason };

export type ProactiveInput = {
  now: Date;
  /** 实例开关（D047 默认 false） */
  enabled: boolean;
  /** 关系亲密度 0-100 */
  affinity: number;
  /** 上次互动（聊过天）的时间；`null` = 从来没说过话 */
  lastInteractionAt: Date | null;
  /** 上次**主动**发消息给这个人的时间 */
  lastProactiveAt: Date | null;
  /** 这个实例今天已经主动发了几条 */
  instanceCountToday: number;
};

const HOUR_MS = 60 * 60 * 1000;

function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / HOUR_MS;
}

/** 本地时区的夜间静默判断。跨零点（23 → 8）时 `start > end`，必须分开判 */
export function isQuietHour(now: Date, limits = PROACTIVE_LIMITS): boolean {
  const hour = now.getHours();
  return hour >= limits.quietStartHour || hour < limits.quietEndHour;
}

/**
 * 该不该主动开口。
 *
 * 纯函数：不查库、不看时钟（`now` 由调用方给）。这样"凌晨三点不该发"这种规则
 * 能一行测一次，而不用造一堆时间数据。
 */
export function decideProactive(input: ProactiveInput, limits = PROACTIVE_LIMITS): ProactiveDecision {
  if (!input.enabled) {
    return { speak: false, reason: 'disabled' };
  }

  // 夜间静默放在最前（开关之后）：它跟这个人是谁、聊得多好都没关系
  if (isQuietHour(input.now, limits)) {
    return { speak: false, reason: 'quiet-hours' };
  }

  if (!input.lastInteractionAt) {
    // 从没说过话 = 没有"想起你"的资格。这不是漏判，是刻意的：
    // 主动找陌生人说话，在任何平台上都是最像营销号的行为
    return { speak: false, reason: 'never-talked' };
  }

  if (input.affinity < limits.minAffinity) {
    return { speak: false, reason: 'not-close-enough' };
  }

  const idleHours = hoursBetween(input.lastInteractionAt, input.now);
  if (idleHours < limits.minIdleHours) {
    return { speak: false, reason: 'too-soon' };
  }

  if (input.lastProactiveAt && hoursBetween(input.lastProactiveAt, input.now) < limits.peerCooldownHours) {
    return { speak: false, reason: 'peer-cooldown' };
  }

  if (input.instanceCountToday >= limits.perInstancePerDay) {
    return { speak: false, reason: 'instance-cap' };
  }

  return { speak: true, reason: 'idle-close-friend', idleHours: Math.floor(idleHours) };
}
