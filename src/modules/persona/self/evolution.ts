/**
 * 人格演化的**代码闸门**（D020 第 5 条 / M5-2）。
 *
 * 模型只能提交"提案"，能不能落地由这里判 —— 这是 D020 里那张四层结构表的关键：
 * **演化层的写入权属于代码，不属于模型**。模型可以建议"我最近更直接了一点"，
 * 但它不能决定"我变成一个更直接的人"。
 *
 * ## 五道闸
 *
 * | 闸 | 规则 | 防什么 |
 * |---|---|---|
 * | 键白名单 | `self` 里只允许 `traits` / `narrative` | 模型试图写"规则""红线""人设" → 整次丢弃（红线结构上不可达，这里只是门口再加一道） |
 * | 单次幅度 | 每个维度 \|Δ\| ≤ 0.03 | 一轮对话就从温吞变刻薄 |
 * | 单日累计 | 每个维度当日累计 ≤ 0.08 | 十轮微小变化加起来等于换个人 |
 * | 范围 | clamp 到 [0.05, 0.95]，`edge` 下限 0.25 | 漂成"讨好型"或"抬杠机器" |
 * | 溯源 | 必须挂上这次反思**真实写入**的记忆 id | 编造经历来改变自己 |
 *
 * 最后一条与 D020 的字面写法不同，值得说明：D020 写的是"反思输出必须引用真实 memoryIds"。
 * 让模型自己报 id，它一定会编（它根本看不到 id）。所以这里反过来做：
 * **代码把这次真正落库的记忆 id 绑上去**，没有新记忆就不动性格。
 * 这比"校验模型报的 id 是否存在"更强 —— 前者证明"确实学到了东西"，后者只能证明"没瞎报"。
 *
 * ## 为什么这些数字写死在代码里
 *
 * D020 原话：演化闸门"写死在代码，不开放配置放宽"。一个能调的闸门等于没有闸门：
 * 出事时第一个被调的就是它。要改就改这份文件并留下决策记录。
 */

import { DEFAULT_TRAITS, TRAITS, type TraitKey, type Traits } from './traits';

export { DEFAULT_TRAITS, TRAITS, type TraitKey, type Traits };

export const EVOLUTION_LIMITS = {
  /** 单次反思里每个维度最多动多少 */
  perCall: 0.03,
  /** 单日累计（按维度）最多动多少 */
  perDay: 0.08,
  /** 特质下界：再低就不是"性格"而是"没有性格" */
  min: 0.05,
  /** 特质上界：留一点余地，别变成单维度人格 */
  max: 0.95,
  /** 棱角下限（D020）：防止长期演化成只会顺着说的样子 */
  edgeMin: 0.25,
  /** 自述长度上限（约 600 token 的中文量） */
  narrativeChars: 1200,
} as const;

/** 一次演化提案（已通过结构校验） */
export type SelfProposal = {
  deltas: Partial<Record<TraitKey, number>>;
  narrative: string | null;
};

export type EvolutionRejectReason =
  | 'no-proposal'
  | 'unknown-key'
  | 'invalid-delta'
  | 'no-memory'
  | 'no-change'
  | 'bad-narrative';

export type EvolutionPlan =
  | {
      ok: true;
      /** 演化后的完整特质（不是增量） */
      traits: Traits;
      narrative: string;
      /** 实际应用的变化量（可能被单日预算削减过） */
      deltas: Partial<Record<TraitKey, number>>;
      /** 有没有真的变化（都是 0 且自述没改 = 没变化） */
      changed: boolean;
    }
  | { ok: false; reason: EvolutionRejectReason; detail: string };

/** `self` 里允许出现的键。别的键一律整次丢弃 —— 见文件头「键白名单」 */
const ALLOWED_KEYS = new Set(['traits', 'narrative']);

function isTraitKey(value: string): value is TraitKey {
  return (TRAITS as readonly string[]).includes(value);
}

/**
 * 宽容解析：从反思输出里的 `self` 字段拿到提案。
 *
 * 「宽容」指允许字段缺失、允许只改自述不改数值；
 * **不宽容**的是结构本身 —— 多一个键就是 `unknown-key`，因为多出来的键
 * 只可能是模型想写别的东西（规则 / 红线 / 人设）。
 */
export function parseProposal(
  raw: unknown,
): { ok: true; proposal: SelfProposal } | { ok: false; reason: EvolutionRejectReason; detail: string } {
  if (raw === null || raw === undefined) {
    return { ok: false, reason: 'no-proposal', detail: '反思没有产出 self 字段' };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'no-proposal', detail: 'self 不是对象' };
  }

  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key)) {
      return {
        ok: false,
        reason: 'unknown-key',
        detail: `self 里出现了不允许的键：${key}`,
      };
    }
  }

  const deltas: Partial<Record<TraitKey, number>> = {};
  const rawTraits = record.traits;
  if (rawTraits !== undefined && rawTraits !== null) {
    if (typeof rawTraits !== 'object' || Array.isArray(rawTraits)) {
      return { ok: false, reason: 'invalid-delta', detail: 'traits 不是对象' };
    }
    for (const [key, value] of Object.entries(rawTraits as Record<string, unknown>)) {
      if (!isTraitKey(key)) {
        return { ok: false, reason: 'unknown-key', detail: `未知的特质维度：${key}` };
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, reason: 'invalid-delta', detail: `特质 ${key} 不是数字` };
      }
      if (value !== 0) {
        deltas[key] = value;
      }
    }
  }

  let narrative: string | null = null;
  if (typeof record.narrative === 'string') {
    const text = record.narrative.trim();
    if (text.length > 0) {
      narrative = text;
    }
  }

  return { ok: true, proposal: { deltas, narrative } };
}

/** 库里的 traitsJson 可能为空、坏掉、多出未知键：一律按"缺省 0.5"补齐并夹紧 */
export function parseTraits(json: string | null | undefined): Traits {
  const result: Traits = { ...DEFAULT_TRAITS };
  if (!json) {
    return result;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return result;
  }
  if (!parsed || typeof parsed !== 'object') {
    return result;
  }
  for (const key of TRAITS) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      result[key] = clampTrait(key, value);
    }
  }
  return result;
}

function clampTrait(key: TraitKey, value: number): number {
  const lower = key === 'edge' ? EVOLUTION_LIMITS.edgeMin : EVOLUTION_LIMITS.min;
  return Math.min(EVOLUTION_LIMITS.max, Math.max(lower, value));
}

/**
 * 闸门本体：把提案变成"下一版自己"，或者拒绝。
 *
 * `todayTotals` 是**今天已经应用过的累计变化量**（按维度），由服务层从版本表里算出来传进来。
 * 为什么不在这里查库：这个函数必须是纯的 —— 闸门是安全边界，得能一行一行读、能穷举测试。
 */
export function planEvolution(input: {
  current: { traits: Traits; narrative: string };
  proposal: SelfProposal;
  /** 今天各维度已累计的变化量（有符号） */
  todayTotals: Partial<Record<TraitKey, number>>;
  /** 这次反思真正写入的记忆 id；为空 = 没学到东西 */
  memoryIds: readonly string[];
}): EvolutionPlan {
  if (input.memoryIds.length === 0) {
    return { ok: false, reason: 'no-memory', detail: '这次反思没有写入任何新记忆' };
  }

  const traits: Traits = { ...input.current.traits };
  const applied: Partial<Record<TraitKey, number>> = {};

  for (const key of TRAITS) {
    const suggested = input.proposal.deltas[key];
    if (suggested === undefined) {
      continue;
    }

    // ① 单次幅度
    const perCall = Math.max(-EVOLUTION_LIMITS.perCall, Math.min(EVOLUTION_LIMITS.perCall, suggested));

    // ② 单日累计：超出剩余预算就削减到剩余额度（而不是整次拒绝 —— 削减更符合"慢慢变"）
    const used = input.todayTotals[key] ?? 0;
    const remaining = Math.max(0, EVOLUTION_LIMITS.perDay - Math.abs(used));
    // 已经朝反方向动过的情况下，反方向的额度也要算在内：这里按"绝对值预算"处理
    const budgeted = Math.max(-remaining, Math.min(remaining, perCall));

    const next = clampTrait(key, traits[key] + budgeted);
    const actual = Number((next - traits[key]).toFixed(4));
    traits[key] = next;
    if (actual !== 0) {
      applied[key] = actual;
    }
  }

  let narrative = input.current.narrative;
  if (input.proposal.narrative !== null) {
    if (input.proposal.narrative.length > EVOLUTION_LIMITS.narrativeChars) {
      return {
        ok: false,
        reason: 'bad-narrative',
        detail: `自述超过 ${EVOLUTION_LIMITS.narrativeChars} 字`,
      };
    }
    narrative = input.proposal.narrative;
  }

  const changed =
    Object.keys(applied).length > 0 || narrative !== input.current.narrative;

  if (!changed) {
    return { ok: false, reason: 'no-change', detail: '提案被闸门削到没有变化' };
  }

  return { ok: true, traits, narrative, deltas: applied, changed };
}

/**
 * 把特质翻译成 prompt 里的几句话。
 *
 * **只在这几项明显偏离中间值时说话**（和语气提示同一个思路）：把 0.52 写成
 * "你有点温和"只会变成噪声，而且模型会把它当设定去演。
 */
export function describeTraits(traits: Traits): string[] {
  const lines: string[] = [];

  if (traits.edge >= 0.7) {
    lines.push('你现在说话比以前直接，不太绕弯子，该顶回去就顶回去。');
  } else if (traits.edge <= 0.35) {
    lines.push('你现在说话比以前收敛，能不怼就不怼。');
  }

  if (traits.warm >= 0.7) {
    lines.push('你对人比以前热络，愿意多问一句。');
  } else if (traits.warm <= 0.35) {
    lines.push('你比以前更淡一点，不太主动热络。');
  }

  if (traits.playful >= 0.7) {
    lines.push('你更爱开玩笑了，正经话也常带点调侃。');
  } else if (traits.playful <= 0.35) {
    lines.push('你少了点玩笑，说话更实在。');
  }

  if (traits.talkative >= 0.7) {
    lines.push('你话比以前多，愿意多聊两句。');
  } else if (traits.talkative <= 0.35) {
    lines.push('你话比以前少，能一句说完就不说两句。');
  }

  return lines;
}
