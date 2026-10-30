import { describe, expect, it } from 'vitest';

import {
  assessHealth,
  DEGRADE_LIMITS,
  HEALTH_LIMITS,
  planDegradation,
  type RiskSignal,
} from '@/modules/risk/health';

const NOW = new Date('2026-10-29T14:00:00');
const MIN = 60_000;
const HOUR = 3600_000;

function signal(code: string, minutesAgo: number, level = 'risk'): RiskSignal {
  return { code, level, createdAt: new Date(NOW.getTime() - minutesAgo * MIN) };
}

/** 信号按时间倒序（最新在前），与仓储的 order by 一致 */
function health(signals: RiskSignal[], status = 'online') {
  return assessHealth({ status, signals, now: NOW });
}

describe('健康分（assessHealth）', () => {
  it('没有任何信号 → 100 / healthy', () => {
    const result = health([]);
    expect(result.score).toBe(100);
    expect(result.level).toBe('healthy');
    expect(result.reasons).toEqual(['无异常信号']);
  });

  it('一次拦截扣 25 分 → 75 分 degraded（动作只是冷却 10 分钟）', () => {
    const result = health([signal('send_blocked', 10)]);
    expect(result.score).toBe(100 - HEALTH_LIMITS.blockPenalty);
    // 等级描述分数，动作描述该干什么：75 分的动作是"冷却"，等级是"degraded"
    expect(result.level).toBe('degraded');
    expect(result.consecutiveBlocks).toBe(1);
  });

  it('两次拦截 → 50 分（readonly 线）且连续计数为 2', () => {
    const result = health([signal('send_blocked', 30), signal('send_blocked', 20)]);
    expect(result.score).toBe(50);
    expect(result.level).toBe('readonly');
    expect(result.consecutiveBlocks).toBe(2);
  });

  it('拦截扣分有上限（60）：再多次也不会扣穿到 0', () => {
    const result = health(Array.from({ length: 8 }, (_, i) => signal('send_blocked', i + 1)));
    expect(result.score).toBe(100 - HEALTH_LIMITS.blockPenaltyCap);
    expect(result.consecutiveBlocks).toBe(8);
  });

  it('中间夹一条发送成功（info）→ 连续计数清零', () => {
    const result = health([
      signal('send_blocked', 5),
      signal('send_ok', 10, 'info'),
      signal('send_blocked', 20),
    ]);
    expect(result.consecutiveBlocks).toBe(1);
  });

  it('掉线类信号扣分，但不推进降级阶梯', () => {
    const result = health([signal('login_lost', 60, 'warn'), signal('offline', 120, 'warn')]);
    expect(result.score).toBe(100 - HEALTH_LIMITS.offlinePenalty * 2);
    expect(result.consecutiveBlocks).toBe(0);
  });

  it('24 小时之外的信号不计入（不让上周的拦截压着分数）', () => {
    const result = health([signal('send_blocked', HEALTH_LIMITS.windowHours * 60 + 1)]);
    expect(result.score).toBe(100);
    expect(result.consecutiveBlocks).toBe(0);
  });

  it('实例状态本身是 banned → stopped，分数归零', () => {
    const result = health([], 'banned');
    expect(result.level).toBe('stopped');
    expect(result.score).toBe(0);
  });

  it('分数很低但没有连续拦截 → 等级按分数走，降级动作仍看连续次数', () => {
    // 10 次掉线：扣满 30 分 → 70 分 degraded
    const result = health(Array.from({ length: 10 }, (_, i) => signal('offline', i + 1, 'warn')));
    expect(result.score).toBe(70);
    expect(result.level).toBe('degraded');
    expect(result.consecutiveBlocks).toBe(0);
  });
});

describe('降级阶梯（planDegradation）', () => {
  it('没有连续拦截 → 不动', () => {
    expect(planDegradation({ consecutiveBlocks: 0, now: NOW, currentSilentUntil: null })).toEqual({
      kind: 'none',
    });
  });

  it('1 次 → 冷却 10 分钟', () => {
    const action = planDegradation({ consecutiveBlocks: 1, now: NOW, currentSilentUntil: null });
    expect(action.kind).toBe('cooldown');
    if (action.kind === 'cooldown') {
      expect(action.until.getTime()).toBe(NOW.getTime() + DEGRADE_LIMITS.cooldownMinutes * MIN);
    }
  });

  it('2 次 → 只收不发 6 小时', () => {
    const action = planDegradation({ consecutiveBlocks: 2, now: NOW, currentSilentUntil: null });
    expect(action.kind).toBe('readonly');
    if (action.kind === 'readonly') {
      expect(action.until.getTime()).toBe(NOW.getTime() + DEGRADE_LIMITS.readonlyHours * HOUR);
    }
  });

  it('3 次及以上 → 停实例', () => {
    const action = planDegradation({ consecutiveBlocks: 3, now: NOW, currentSilentUntil: null });
    expect(action.kind).toBe('stop');
  });

  it('已有的静默更长时保留更长的那一个（只升不降）', () => {
    const existing = new Date(NOW.getTime() + 5 * HOUR);
    const action = planDegradation({ consecutiveBlocks: 1, now: NOW, currentSilentUntil: existing });
    expect(action.kind).toBe('cooldown');
    if (action.kind === 'cooldown') {
      // 不能因为又算了一次就把 5 小时缩短成 10 分钟
      expect(action.until.getTime()).toBe(existing.getTime());
    }
  });
});
