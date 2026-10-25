/**
 * 发言决策：要不要回这条（M3-2）。
 *
 * ## 为什么不是"有消息就回"
 *
 * 秒回每条 = 最像机器人的行为。真实的人在群里大部分消息只看不回，
 * 而且"回不回"跟四个东西有关：有没有点它的名、累不累、跟这个人熟不熟、群里是不是在聊。
 * 所以这里算一个连续唤醒度 `wake`，再与人格阈值比较。
 *
 * ## 一条硬规则，其余全是阈值
 *
 * **群里被 @ 必回**。这条不能交给任何概率或权重：@ 是"我在叫你"的明确信号，
 * 不回就是坏了，不是"性格高冷"。其余情况才走阈值。
 *
 * ## 为什么不用随机数
 *
 * 同一组输入永远得到同一个结论。好处是线上问题可复现、测试能精确断言；
 * 代价是"偶尔看一眼不回"这种随机性要靠状态变化来体现——而状态本来就在变
 * （精力在衰减、亲密度在涨），这比扔骰子更接近真实原因。
 *
 * ## `busy` 只影响群聊
 *
 * 忙碌在私聊的语义是"回得慢"，不是"不回"。让 `busy` 在私聊也抬高阈值，
 * 会出现"单独找你也不理"——那不像忙，像关系断了。
 */

import type { AttentionPolicy } from './policy';

export type AttentionInput = {
  channel: 'private' | 'group';
  /** 平台层面是否被 @ / 叫到名字 */
  isMentioned: boolean;
  state: {
    energy: number;
    /** 是否处于忙碌时段（`busyUntil` 未过期） */
    busy: boolean;
  };
  /** 0-100 的亲密度 */
  affinity: number;
  /** 上一条是自己说的，对方在接它的话 */
  followUp: boolean;
  /** 0-1 的群内热度；私聊传 0 */
  groupActivity: number;
  /** 0-1 的话题相关度；没有兴趣标签数据时传 0（M5 才有） */
  topicMatch?: number;
};

export type AttentionReason = 'mentioned' | 'above_threshold' | 'below_threshold';

export type AttentionDecision = {
  speak: boolean;
  /** 唤醒度（0-1 量级，可略超 1） */
  wake: number;
  /** 本次使用的阈值 */
  threshold: number;
  reason: AttentionReason;
};

function unit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

export function computeWake(
  input: AttentionInput,
  policy: AttentionPolicy,
): { wake: number; threshold: number } {
  const weights = policy.weights;

  let wake = policy.base;
  if (input.channel === 'private') {
    wake += policy.privateBoost;
  }
  wake += weights.mention * (input.isMentioned ? 1 : 0);
  wake += weights.topicMatch * unit(input.topicMatch ?? 0);
  wake += weights.followUp * (input.followUp ? 1 : 0);
  wake += weights.groupVibe * unit(input.groupActivity);
  wake += weights.affinity * unit(input.affinity / 100);
  wake -= weights.lowEnergy * unit(1 - input.state.energy);

  const threshold =
    input.channel === 'private'
      ? policy.thresholdPrivate
      : input.state.busy
        ? policy.thresholdBusy
        : policy.thresholdGroup;

  return { wake, threshold };
}

export function decideAttention(
  input: AttentionInput,
  policy: AttentionPolicy,
): AttentionDecision {
  const { wake, threshold } = computeWake(input, policy);

  // 硬规则：群里被点名必须回，不受阈值与精力影响
  if (input.channel === 'group' && input.isMentioned) {
    return { speak: true, wake, threshold, reason: 'mentioned' };
  }

  return wake > threshold
    ? { speak: true, wake, threshold, reason: 'above_threshold' }
    : { speak: false, wake, threshold, reason: 'below_threshold' };
}
