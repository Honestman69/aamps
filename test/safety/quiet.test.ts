import { describe, expect, it } from 'vitest';

import { isWithinQuiet, parseQuietWindow } from '@/modules/safety/quiet';

const at = (h: number, m = 0): Date => new Date(`2026-10-29T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`);

describe('解析静默时段', () => {
  it('正常区间 / 跨零点都能解析', () => {
    expect(parseQuietWindow('00:30-07:30')).toEqual({ startMin: 30, endMin: 450 });
    expect(parseQuietWindow('23:00-08:00')).toEqual({ startMin: 1380, endMin: 480 });
    expect(parseQuietWindow(' 9:05 - 10:00 ')).toEqual({ startMin: 545, endMin: 600 });
  });

  it('off / 空 / 起止相同 / 非法 → null（等于关闭）', () => {
    for (const value of ['off', 'OFF', '', '   ', null, undefined, '23:00-23:00', '25:00-01:00', 'abc', '00:70-08:00']) {
      expect(parseQuietWindow(value as string | null | undefined)).toBeNull();
    }
  });
});

describe('当前是否在静默期（左闭右开）', () => {
  const QUIET = '00:30-07:30';

  it('区间内为真，起止边界按左闭右开', () => {
    expect(isWithinQuiet(at(0, 29), QUIET)).toBe(false);
    expect(isWithinQuiet(at(0, 30), QUIET)).toBe(true);
    expect(isWithinQuiet(at(3), QUIET)).toBe(true);
    expect(isWithinQuiet(at(7, 29), QUIET)).toBe(true);
    // 07:30 整必须放行 —— 否则"整点算不算"永远说不清
    expect(isWithinQuiet(at(7, 30), QUIET)).toBe(false);
  });

  it('跨零点（23:00-08:00）两边都算', () => {
    expect(isWithinQuiet(at(23), '23:00-08:00')).toBe(true);
    expect(isWithinQuiet(at(1), '23:00-08:00')).toBe(true);
    expect(isWithinQuiet(at(7, 59), '23:00-08:00')).toBe(true);
    expect(isWithinQuiet(at(8), '23:00-08:00')).toBe(false);
    expect(isWithinQuiet(at(14), '23:00-08:00')).toBe(false);
  });

  it('配成 off 或坏值 → 永远不静默（配错不能变成"整天不说话"）', () => {
    expect(isWithinQuiet(at(3), 'off')).toBe(false);
    expect(isWithinQuiet(at(3), 'garbage')).toBe(false);
  });
});
