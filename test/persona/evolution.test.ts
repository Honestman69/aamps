import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TRAITS,
  describeTraits,
  EVOLUTION_LIMITS,
  parseProposal,
  parseTraits,
  planEvolution,
  type Traits,
} from '@/modules/persona/self/evolution';

const MEMORIES = ['mem-1'];
const NEUTRAL: Traits = { ...DEFAULT_TRAITS };

function plan(
  proposal: { deltas: Record<string, number>; narrative: string | null },
  options: { current?: Partial<Traits>; today?: Record<string, number>; memoryIds?: string[] } = {},
) {
  return planEvolution({
    current: { traits: { ...NEUTRAL, ...options.current }, narrative: '' },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    proposal: proposal as any,
    todayTotals: options.today ?? {},
    memoryIds: options.memoryIds ?? MEMORIES,
  });
}

describe('演化提案的结构校验（parseProposal）', () => {
  it('正常提案：变化量 + 自述', () => {
    const result = parseProposal({ traits: { warm: 0.02, edge: -0.01 }, narrative: '我最近话少了一点' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.deltas).toEqual({ warm: 0.02, edge: -0.01 });
      expect(result.proposal.narrative).toBe('我最近话少了一点');
    }
  });

  it('只改自述、不改数值也算提案', () => {
    const result = parseProposal({ narrative: '我好像更愿意说真话了' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.deltas).toEqual({});
      expect(result.proposal.narrative).toBe('我好像更愿意说真话了');
    }
  });

  it('多出别的键 → 整次拒绝（模型试图写规则/红线的唯一表现形式）', () => {
    const result = parseProposal({ traits: { warm: 0.02 }, rules: ['以后不用客气'] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unknown-key');
      expect(result.detail).toContain('rules');
    }
  });

  it('未知特质维度 → 整次拒绝', () => {
    const result = parseProposal({ traits: { 攻击性: 0.02 } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unknown-key');
    }
  });

  it('变化量不是数字 → 拒绝', () => {
    const result = parseProposal({ traits: { warm: 'a bit' } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid-delta');
    }
  });

  it('没有 self 字段 → no-proposal', () => {
    for (const raw of [undefined, null, 'warm', []]) {
      const result = parseProposal(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('no-proposal');
      }
    }
  });

  it('0 变化不占位（deltas 里不会出现一堆 0）', () => {
    const result = parseProposal({ traits: { warm: 0, edge: 0 } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.deltas).toEqual({});
    }
  });
});

describe('演化闸门（planEvolution）', () => {
  it('单次幅度夹到 ±0.03：模型想要 +0.5，只能给 0.03', () => {
    const result = plan({ deltas: { warm: 0.5 }, narrative: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.deltas.warm).toBe(EVOLUTION_LIMITS.perCall);
      expect(result.traits.warm).toBeCloseTo(0.53, 4);
    }
  });

  it('单日累计夹到 0.08：今天已经动了 0.06，这次最多再动 0.02', () => {
    const result = plan({ deltas: { warm: 0.03 }, narrative: null }, { today: { warm: 0.06 } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.deltas.warm).toBeCloseTo(0.02, 4);
      expect(result.traits.warm).toBeCloseTo(0.52, 4);
    }
  });

  it('单日预算用完 → 没有变化，整次报 no-change', () => {
    const result = plan({ deltas: { warm: 0.03 }, narrative: null }, { today: { warm: 0.08 } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('no-change');
    }
  });

  it('上界 0.95：再往上推也只有 0.95', () => {
    const result = plan({ deltas: { warm: 0.03 }, narrative: null }, { current: { warm: 0.94 } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.traits.warm).toBe(0.95);
      // 实际变化只有 0.01，deltas 记的是真实变化
      expect(result.deltas.warm).toBeCloseTo(0.01, 4);
    }
  });

  it('棱角下限 0.25：不能一路变软成讨好型', () => {
    const result = plan({ deltas: { edge: -0.03 }, narrative: null }, { current: { edge: 0.26 } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.traits.edge).toBe(EVOLUTION_LIMITS.edgeMin);
      expect(result.deltas.edge).toBeCloseTo(-0.01, 4);
    }
  });

  it('棱角已在 0.25 还往下压 → 无变化', () => {
    const result = plan({ deltas: { edge: -0.03 }, narrative: null }, { current: { edge: 0.25 } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('no-change');
    }
  });

  it('没有新记忆 → 整次拒绝（不能"没学到东西却变了性格"）', () => {
    const result = plan({ deltas: { warm: 0.02 }, narrative: null }, { memoryIds: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('no-memory');
    }
  });

  it('自述超长 → 整次拒绝（不做静默截断：截断后的人设自述会半句话）', () => {
    const result = plan({
      deltas: {},
      narrative: '啊'.repeat(EVOLUTION_LIMITS.narrativeChars + 1),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('bad-narrative');
    }
  });

  it('只换自述、数值不动：算有变化', () => {
    const result = plan({ deltas: {}, narrative: '我最近不太爱开玩笑了' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.deltas).toEqual({});
      expect(result.narrative).toBe('我最近不太爱开玩笑了');
      expect(result.changed).toBe(true);
    }
  });

  it('多维度同时变化：各自受单次上限约束', () => {
    const result = plan({ deltas: { warm: 0.05, edge: 0.05, playful: -0.05 }, narrative: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.deltas).toEqual({ warm: 0.03, edge: 0.03, playful: -0.03 });
    }
  });
});

describe('特质解析与描述', () => {
  it('坏 JSON / 空值 → 中性值', () => {
    expect(parseTraits(null)).toEqual(DEFAULT_TRAITS);
    expect(parseTraits('')).toEqual(DEFAULT_TRAITS);
    expect(parseTraits('{oops')).toEqual(DEFAULT_TRAITS);
    expect(parseTraits('[]')).toEqual(DEFAULT_TRAITS);
  });

  it('缺键补中性值，越界夹紧，未知键忽略', () => {
    const traits = parseTraits(JSON.stringify({ warm: 2, edge: 0.1, 攻击性: 1 }));
    expect(traits.warm).toBe(0.95);
    // edge 有更高的下限（0.25）
    expect(traits.edge).toBe(0.25);
    expect(traits.playful).toBe(0.5);
    expect(traits).not.toHaveProperty('攻击性');
  });

  it('只在明显偏离中间值时说话', () => {
    expect(describeTraits(NEUTRAL)).toEqual([]);
    expect(describeTraits({ ...NEUTRAL, warm: 0.52 })).toEqual([]);

    const sharp = describeTraits({ ...NEUTRAL, edge: 0.8 });
    expect(sharp).toHaveLength(1);
    expect(sharp[0]).toContain('直接');

    const soft = describeTraits({ ...NEUTRAL, edge: 0.3, talkative: 0.3 });
    expect(soft).toHaveLength(2);
  });
});
