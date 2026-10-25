import { describe, expect, it } from 'vitest';

import {
  applyReply,
  createMindState,
  decayState,
  energyBaseline,
  isBusy,
  localHour,
  type MindState,
} from '@/modules/mind/state/mind-state';

const at = (iso: string) => new Date(iso);

function state(overrides: Partial<MindState> = {}): MindState {
  return {
    mood: 0,
    energy: 0.8,
    busyUntil: null,
    lastDecayAt: at('2026-10-24T12:00:00'),
    ...overrides,
  };
}

describe('作息曲线', () => {
  it('深夜低、上午高、午后有低谷', () => {
    expect(energyBaseline(3)).toBeCloseTo(0.4, 2);
    expect(energyBaseline(12)).toBeCloseTo(0.9, 2);
    expect(energyBaseline(13.5)).toBeLessThan(energyBaseline(12));
    expect(energyBaseline(20)).toBeCloseTo(0.88, 2);
  });

  it('锚点之间线性插值，24 点与 0 点一致', () => {
    // 3 点 0.40、6 点 0.45 → 4.5 点 0.425
    expect(energyBaseline(4.5)).toBeCloseTo(0.425, 3);
    expect(energyBaseline(24)).toBeCloseTo(energyBaseline(0), 3);
    // 负数/超 24 小时用取模，不越界
    expect(energyBaseline(-1)).toBeCloseTo(energyBaseline(23), 3);
  });

  it('当地小时含分钟', () => {
    expect(localHour(new Date(2026, 9, 24, 13, 30))).toBeCloseTo(13.5, 5);
  });
});

describe('decayState', () => {
  it('情绪每小时向基线回归 8%', () => {
    const next = decayState(state({ mood: 1 }), at('2026-10-24T13:00:00'));
    expect(next.mood).toBeCloseTo(0.92, 4);
  });

  it('零间隔不变（也不推进起点）', () => {
    const s = state();
    expect(decayState(s, at('2026-10-24T12:00:00'))).toEqual(s);
  });

  it('时钟回拨不衰减、不推进起点', () => {
    const s = state({ mood: 0.5 });
    const next = decayState(s, at('2026-10-24T11:00:00'));
    expect(next.mood).toBe(0.5);
    expect(next.lastDecayAt).toEqual(s.lastDecayAt);
  });

  it('精力向当下曲线的基线收敛，不会自己飘走', () => {
    // 12 点精力 0 出发，6 小时（曲线在 18 点附近约 0.87）
    const next = decayState(
      state({ energy: 0, lastDecayAt: at('2026-10-24T12:00:00') }),
      at('2026-10-24T18:00:00'),
    );
    const baseline = energyBaseline(18);
    expect(next.energy).toBeGreaterThan(0.7);
    expect(next.energy).toBeLessThan(baseline);
  });

  it('过期的 busyUntil 被清空，未过期的保留', () => {
    const expired = decayState(
      state({ busyUntil: at('2026-10-24T11:00:00') }),
      at('2026-10-24T12:00:00'),
    );
    expect(expired.busyUntil).toBeNull();

    const alive = decayState(
      state({ busyUntil: at('2026-10-24T15:00:00') }),
      at('2026-10-24T12:00:00'),
    );
    expect(alive.busyUntil).toEqual(at('2026-10-24T15:00:00'));
  });
});

describe('applyReply 与 isBusy', () => {
  it('回话消耗精力，数值被夹在合法区间', () => {
    expect(applyReply(state()).energy).toBeCloseTo(0.78, 5);
    // 已经没精力了也不会变成负数
    expect(applyReply(state({ energy: 0.01 })).energy).toBe(0);
    // 情绪被夹在 [-1, 1]
    expect(applyReply(state({ mood: 0.95 }), { moodShift: 0.5 }).mood).toBe(1);
    expect(applyReply(state({ mood: -0.95 }), { moodShift: -0.5 }).mood).toBe(-1);
  });

  it('isBusy 只看截止时间有没有过', () => {
    const now = at('2026-10-24T12:00:00');
    expect(isBusy(state({ busyUntil: at('2026-10-24T12:00:01') }), now)).toBe(true);
    expect(isBusy(state({ busyUntil: at('2026-10-24T12:00:00') }), now)).toBe(false);
    expect(isBusy(state({ busyUntil: null }), now)).toBe(false);
  });

  it('新建状态取默认精力并记录起点', () => {
    const now = at('2026-10-24T12:00:00');
    const s = createMindState(now);
    expect(s.energy).toBe(0.8);
    expect(s.mood).toBe(0);
    expect(s.lastDecayAt).toEqual(now);
  });
});
