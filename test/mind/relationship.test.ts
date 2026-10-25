import { describe, expect, it } from 'vitest';

import {
  affinityGain,
  decayAffinity,
  nextAffinity,
  type RelationshipSnapshot,
} from '@/modules/mind/state/relationship';

const at = (iso: string) => new Date(iso);

function rel(overrides: Partial<RelationshipSnapshot> = {}): RelationshipSnapshot {
  return {
    peerId: 'peer-1',
    nickname: '阿明',
    affinity: 20,
    trust: 0,
    lastInteractionAt: at('2026-10-24T12:00:00'),
    ...overrides,
  };
}

describe('affinityGain', () => {
  it('私聊回话比群里回话涨得多', () => {
    const p = affinityGain({ channel: 'private', replied: true, mentioned: false, textLength: 10 });
    const g = affinityGain({ channel: 'group', replied: true, mentioned: false, textLength: 10 });
    expect(p).toBeGreaterThan(g);
  });

  it('看到了没回也涨，但明显更少', () => {
    const replied = affinityGain({ channel: 'private', replied: true, mentioned: false, textLength: 10 });
    const ignored = affinityGain({ channel: 'private', replied: false, mentioned: false, textLength: 10 });
    expect(ignored).toBeGreaterThan(0);
    expect(ignored).toBeLessThan(replied);
  });

  it('被点名加权重，长消息有上限', () => {
    const plain = affinityGain({ channel: 'group', replied: true, mentioned: false, textLength: 10 });
    const called = affinityGain({ channel: 'group', replied: true, mentioned: true, textLength: 10 });
    expect(called - plain).toBeCloseTo(0.4, 5);

    // 5000 字不会把亲密度一次顶满：单次涨幅封顶 2
    const long = affinityGain({ channel: 'private', replied: true, mentioned: true, textLength: 5000 });
    expect(long).toBeLessThanOrEqual(2);
  });
});

describe('decayAffinity', () => {
  it('宽限期内不掉', () => {
    expect(decayAffinity(rel(), at('2026-10-30T12:00:00'))).toBeCloseTo(20, 5);
  });

  it('超过宽限期后每天掉 1', () => {
    // 交互后 9 天：宽限 7 天 + 掉 2 天
    expect(decayAffinity(rel(), at('2026-11-02T12:00:00'))).toBeCloseTo(18, 5);
  });

  it('不会掉到负数', () => {
    expect(decayAffinity(rel({ affinity: 2 }), at('2027-10-24T12:00:00'))).toBe(0);
  });

  it('没有交互时间的记录原样返回', () => {
    expect(decayAffinity(rel({ lastInteractionAt: null }), at('2027-10-24T12:00:00'))).toBe(20);
  });
});

describe('nextAffinity', () => {
  it('先衰减再加本次涨幅，并把交互时间推到 now', () => {
    const now = at('2026-11-02T12:00:00'); // 空窗 9 天 → 衰减到 18
    const next = nextAffinity(
      rel(),
      { channel: 'private', replied: true, mentioned: false, textLength: 10 },
      now,
    );
    expect(next.affinity).toBeCloseTo(18 + 1 + 10 / 500, 4);
    expect(next.lastInteractionAt).toEqual(now);
  });

  it('第一次交互从 0 起算', () => {
    const next = nextAffinity(
      null,
      { channel: 'group', replied: true, mentioned: false, textLength: 0 },
      at('2026-10-24T12:00:00'),
    );
    expect(next.affinity).toBeCloseTo(0.6, 5);
  });

  it('封顶 100', () => {
    const next = nextAffinity(
      rel({ affinity: 99.9 }),
      { channel: 'private', replied: true, mentioned: true, textLength: 400 },
      at('2026-10-24T13:00:00'),
    );
    expect(next.affinity).toBe(100);
  });
});
