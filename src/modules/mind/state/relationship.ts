/**
 * 关系（亲密度）：累积与衰减（M3-1）。
 *
 * 亲密度不是"聊得越多越高"这么简单，否则刷屏的人三天就能满分。这里的口径是：
 * **一次交互涨多少，取决于这一次是不是双向的、对方有没有点名、说了多少**。
 * 看了不回也涨，但只涨一点点——那本来就是"远远看着"的关系。
 *
 * ## 衰减为什么要跟 `lastInteractionAt` 绑在一起
 *
 * 衰减是**从上次交互算到现在**这一段的量，不是"每次调用都扣一点"。
 * 如果把 `decayAffinity()` 写成无状态的"每次 -1"，同一段空窗会被反复扣：
 * 查询一次扣一次，跑一次定时任务又扣一次，亲密度会莫名其妙归零。
 * 所以约定：**衰减只在真正写库的那一次算，并且写完把 `lastInteractionAt` 推到 now**。
 * 对应实现是 `nextAffinity()` —— 上层只调它，不单独调 `decayAffinity()` 再自己拼。
 *
 * ## 单位
 *
 * `affinity` / `trust` 在库里是 `Int`（0-100），这里用浮点算，写库前四舍五入。
 * 保留小数是为了让"一天聊二十句"和"一天聊一句"能区分开，直接取整会把前者抹平。
 */

export const AFFINITY_RANGE = { min: 0, max: 100 } as const;

/** 冷落多久之后才开始掉 */
export const AFFINITY_IDLE_GRACE_MS = 7 * 24 * 3_600_000;

/** 过了宽限期，每空一天掉多少 */
export const AFFINITY_DECAY_PER_DAY = 1;

/** 单次交互的涨幅上限：防止一段超长对话一次把亲密度顶满 */
export const AFFINITY_GAIN_CAP = 2;

export type RelationshipSnapshot = {
  peerId: string;
  nickname: string | null;
  affinity: number;
  trust: number;
  lastInteractionAt: Date | null;
};

export type InteractionInput = {
  channel: 'private' | 'group';
  /** 这一条有没有真的回。没回也涨一点，但少得多 */
  replied: boolean;
  /** 有没有被 @ / 叫名字 */
  mentioned: boolean;
  /** 入站文本长度，用来区分"嗯"和"说了一大段" */
  textLength: number;
};

export function clampAffinity(value: number): number {
  if (!Number.isFinite(value)) {
    return AFFINITY_RANGE.min;
  }
  return Math.min(AFFINITY_RANGE.max, Math.max(AFFINITY_RANGE.min, value));
}

/**
 * 从上次交互衰减到现在。
 *
 * 宽限期内的空窗不掉：出差一周回来，关系不该已经归零。
 */
export function decayAffinity(rel: RelationshipSnapshot, now: Date): number {
  if (!rel.lastInteractionAt) {
    return clampAffinity(rel.affinity);
  }
  const idleMs = now.getTime() - rel.lastInteractionAt.getTime();
  if (idleMs <= AFFINITY_IDLE_GRACE_MS) {
    return clampAffinity(rel.affinity);
  }
  const days = (idleMs - AFFINITY_IDLE_GRACE_MS) / (24 * 3_600_000);
  return clampAffinity(rel.affinity - days * AFFINITY_DECAY_PER_DAY);
}

/** 这一次交互涨多少 */
export function affinityGain(input: InteractionInput): number {
  // 私聊的每一次交流都比群里一句话重：群里说一句和单独找你说一句，含义不同
  let gain = input.replied ? (input.channel === 'private' ? 1 : 0.6) : 0.2;
  if (input.mentioned) {
    gain += 0.4;
  }
  // 长消息最多再加 0.4：说 200 字和说 20 字确实是两件事，但不该线性放大
  gain += Math.min(0.4, Math.max(0, input.textLength) / 500);
  return Math.min(AFFINITY_GAIN_CAP, gain);
}

/**
 * 算出写库用的新亲密度与新的交互时间。
 *
 * 先衰减到 now，再加这一次的涨幅，最后把 `lastInteractionAt` 推到 now ——
 * 这样"衰减"只会被这一条记录覆盖一次（见文件头）。
 */
export function nextAffinity(
  rel: RelationshipSnapshot | null,
  input: InteractionInput,
  now: Date,
): { affinity: number; lastInteractionAt: Date } {
  const base = rel ? decayAffinity(rel, now) : 0;
  return {
    affinity: clampAffinity(base + affinityGain(input)),
    lastInteractionAt: now,
  };
}
