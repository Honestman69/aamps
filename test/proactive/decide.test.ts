import { describe, expect, it } from 'vitest';

import { decideProactive, isQuietHour, PROACTIVE_LIMITS } from '@/modules/proactive/decide';

/** 一个"正常的工作日下午"：便于确定性断言 */
const NOON = new Date('2026-10-28T14:00:00');
const HOUR = 3600_000;

function hoursAgo(hours: number): Date {
  return new Date(NOON.getTime() - hours * HOUR);
}

const base = {
  now: NOON,
  enabled: true,
  affinity: 60,
  lastInteractionAt: hoursAgo(50),
  lastProactiveAt: null as Date | null,
  instanceCountToday: 0,
};

describe('夜间静默', () => {
  it('23:00–08:00 之内都算安静时段（跨零点要分开判）', () => {
    const at = (h: number) => new Date(`2026-10-28T${String(h).padStart(2, '0')}:00:00`);
    expect(isQuietHour(at(23))).toBe(true);
    expect(isQuietHour(at(0))).toBe(true);
    expect(isQuietHour(at(7))).toBe(true);
    expect(isQuietHour(at(8))).toBe(false);
    expect(isQuietHour(at(14))).toBe(false);
    expect(isQuietHour(at(22))).toBe(false);
  });

  it('半夜即使条件全满足也不发', () => {
    const decision = decideProactive({ ...base, now: new Date('2026-10-28T03:00:00') });
    expect(decision).toEqual({ speak: false, reason: 'quiet-hours' });
  });
});

describe('主动消息闸门', () => {
  it('默认关闭时一律不发（开关优先于其他一切）', () => {
    expect(decideProactive({ ...base, enabled: false })).toEqual({
      speak: false,
      reason: 'disabled',
    });
  });

  it('从没说过话 → never-talked（主动找陌生人像营销号）', () => {
    expect(decideProactive({ ...base, lastInteractionAt: null })).toEqual({
      speak: false,
      reason: 'never-talked',
    });
  });

  it('亲密度不够 → not-close-enough', () => {
    expect(decideProactive({ ...base, affinity: PROACTIVE_LIMITS.minAffinity - 1 })).toEqual({
      speak: false,
      reason: 'not-close-enough',
    });
  });

  it('刚聊完 → too-soon（这是"打扰"，不是"想念"）', () => {
    const decision = decideProactive({ ...base, lastInteractionAt: hoursAgo(47) });
    expect(decision).toEqual({ speak: false, reason: 'too-soon' });
  });

  it('同一人 72 小时内已经被主动过 → peer-cooldown（对方不回就别追）', () => {
    const decision = decideProactive({ ...base, lastProactiveAt: hoursAgo(71) });
    expect(decision).toEqual({ speak: false, reason: 'peer-cooldown' });
  });

  it('今天这个实例已经发了 3 条 → instance-cap（平台风控红线）', () => {
    const decision = decideProactive({ ...base, instanceCountToday: PROACTIVE_LIMITS.perInstancePerDay });
    expect(decision).toEqual({ speak: false, reason: 'instance-cap' });
  });

  it('条件全满足 → 发，并给出"多久没聊"（用于日志）', () => {
    const decision = decideProactive(base);
    expect(decision).toEqual({ speak: true, reason: 'idle-close-friend', idleHours: 50 });
  });

  it('边界值：正好 48 小时 / 正好 40 亲密度 / 正好 72 小时前主动过', () => {
    expect(decideProactive({ ...base, lastInteractionAt: hoursAgo(48) })).toMatchObject({
      speak: true,
    });
    expect(decideProactive({ ...base, affinity: PROACTIVE_LIMITS.minAffinity })).toMatchObject({
      speak: true,
    });
    // 正好 72 小时前主动过 → 冷却已过，可以再发
    expect(decideProactive({ ...base, lastProactiveAt: hoursAgo(72) })).toMatchObject({
      speak: true,
    });
  });

  it('优先级：夜间静默压过亲密度不足（半夜 + 陌生人，报的是 hours）', () => {
    const decision = decideProactive({
      ...base,
      now: new Date('2026-10-28T02:00:00'),
      affinity: 0,
      lastInteractionAt: null,
    });
    expect(decision).toEqual({ speak: false, reason: 'quiet-hours' });
  });
});
