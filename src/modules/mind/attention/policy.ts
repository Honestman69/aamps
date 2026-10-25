/**
 * 发言决策参数（`Persona.behaviorJson.attention`）的解析与校验。
 *
 * 与 `fallbacks` / `quote` 同一套路：**宽容解析，非法值回落默认，不让人格数据坏了就崩**。
 * 但有一处不同：这里**逐字段回落**，不是整块回落。用户手写了三个权重、
 * 其中一个写成 `"high"`，不该让另外两个也失效——那会让"我明明调过但感觉没变"变成常态。
 *
 * 权重与阈值都是 0~1 的小数。范围外的值一律回落默认（而不是夹到边界）：
 * 夹边界会让 `thresholdGroup: 5` 这种明显写错的配置悄悄变成 1（永不回复），
 * 回落默认至少还能正常说话，而且日志/来源里能看出"没生效"。
 */

export type AttentionWeights = {
  /** 被 @ / 叫名字。硬规则之外再叠一层，让"点了名但没到硬阈值"的情况更容易触发 */
  mention: number;
  /** 与角色兴趣相关。M5 有语义记忆后才会有非 0 输入 */
  topicMatch: number;
  /** 上一句是自己说的，对方在接话 */
  followUp: number;
  /** 群内当前热度 */
  groupVibe: number;
  /** 与这个人的亲密度（0-100 归一到 0-1） */
  affinity: number;
  /** 精力越低扣得越多 */
  lowEnergy: number;
};

export type AttentionPolicy = {
  /** 没有任何其他信号时的基础唤醒度 */
  base: number;
  /** 私聊额外加成：私聊几乎必回，但深夜困极了也会不回（见 attention.ts） */
  privateBoost: number;
  thresholdPrivate: number;
  thresholdGroup: number;
  thresholdBusy: number;
  weights: AttentionWeights;
};

export const DEFAULT_ATTENTION_POLICY: AttentionPolicy = {
  base: 0.18,
  privateBoost: 0.15,
  thresholdPrivate: 0.05,
  thresholdGroup: 0.55,
  thresholdBusy: 0.78,
  weights: {
    mention: 0.45,
    topicMatch: 0.3,
    followUp: 0.2,
    groupVibe: 0.15,
    affinity: 0.1,
    lowEnergy: 0.3,
  },
};

function isUnitNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function pickUnit(
  source: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = source[key];
  return isUnitNumber(value) ? value : fallback;
}

/**
 * 从 `behaviorJson` 解析。
 *
 * 只读 `attention` 这一段，其余（expression / rhythm / proactive）留到 M3 后续步骤再解析，
 * 现在读进来也没有消费者。
 */
export function parseAttentionPolicy(raw: string | null): AttentionPolicy {
  const root = parseJsonObject(raw);
  const attention = root?.attention;
  if (!attention || typeof attention !== 'object' || Array.isArray(attention)) {
    return DEFAULT_ATTENTION_POLICY;
  }
  const block = attention as Record<string, unknown>;
  const rawWeights = block.weights;
  const weights =
    rawWeights && typeof rawWeights === 'object' && !Array.isArray(rawWeights)
      ? (rawWeights as Record<string, unknown>)
      : {};

  return {
    base: pickUnit(block, 'base', DEFAULT_ATTENTION_POLICY.base),
    privateBoost: pickUnit(block, 'privateBoost', DEFAULT_ATTENTION_POLICY.privateBoost),
    thresholdPrivate: pickUnit(block, 'thresholdPrivate', DEFAULT_ATTENTION_POLICY.thresholdPrivate),
    thresholdGroup: pickUnit(block, 'thresholdGroup', DEFAULT_ATTENTION_POLICY.thresholdGroup),
    thresholdBusy: pickUnit(block, 'thresholdBusy', DEFAULT_ATTENTION_POLICY.thresholdBusy),
    weights: {
      mention: pickUnit(weights, 'mention', DEFAULT_ATTENTION_POLICY.weights.mention),
      topicMatch: pickUnit(weights, 'topicMatch', DEFAULT_ATTENTION_POLICY.weights.topicMatch),
      followUp: pickUnit(weights, 'followUp', DEFAULT_ATTENTION_POLICY.weights.followUp),
      groupVibe: pickUnit(weights, 'groupVibe', DEFAULT_ATTENTION_POLICY.weights.groupVibe),
      affinity: pickUnit(weights, 'affinity', DEFAULT_ATTENTION_POLICY.weights.affinity),
      lowEnergy: pickUnit(weights, 'lowEnergy', DEFAULT_ATTENTION_POLICY.weights.lowEnergy),
    },
  };
}
