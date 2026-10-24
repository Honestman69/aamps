import { describe, expect, it } from 'vitest';

import { DEFAULT_FALLBACKS, resolveFallback } from '@/modules/persona/fallbacks';
import {
  FALLBACK_SPEAK_LIMITS,
  decideSpeak,
  faultToSlot,
  type SpeakFailureReason,
} from '@/modules/persona/fault-slot';

const at = (iso: string) => new Date(iso);

describe('故障原因 → 话术槽位（D028）', () => {
  it('欠费与 Key 失效都走 longOutage（都要等人处理，不是抖动）', () => {
    expect(faultToSlot('balance')).toBe('longOutage');
    expect(faultToSlot('auth')).toBe('longOutage');
    expect(faultToSlot('no_candidate')).toBe('longOutage');
  });

  it('限流 / 5xx / 网络走 shortOutage', () => {
    expect(faultToSlot('rate_limit')).toBe('shortOutage');
    expect(faultToSlot('provider')).toBe('shortOutage');
    expect(faultToSlot('network')).toBe('shortOutage');
  });

  it('我方限额单独一档：与厂商欠费必须能分辨', () => {
    expect(faultToSlot('budget_exhausted')).toBe('budgetLimit');
    // 这两件事的话术不能是同一个槽位，否则 owner 分不清该充值还是改配置
    expect(faultToSlot('budget_exhausted')).not.toBe(faultToSlot('balance'));
  });

  it('每个原因都有槽位（新增原因时编译期就会报错）', () => {
    const reasons: SpeakFailureReason[] = [
      'balance',
      'auth',
      'no_candidate',
      'rate_limit',
      'provider',
      'network',
      'budget_exhausted',
    ];
    for (const reason of reasons) {
      expect(faultToSlot(reason)).toBeTruthy();
    }
  });
});

describe('出声频率（欠费不能每条消息都回一句）', () => {
  it('首次触发允许出声', () => {
    const d = decideSpeak('longOutage', {
      spokenAt: [],
      hasTemplate: true,
      now: at('2026-10-24T10:00:00'),
    });
    expect(d.speak).toBe(true);
  });

  it('用户把话术配成 null（不说）时必须静默，不能被默认值覆盖', () => {
    // 群聊默认就是 null（D026）
    const texts = DEFAULT_FALLBACKS;
    expect(texts.longOutage.group).toBeNull();
    const text = resolveFallback(texts, 'longOutage', 'group', { groupName: '测试群' });
    expect(text).toBeNull();

    const d = decideSpeak('longOutage', {
      spokenAt: [],
      hasTemplate: text !== null,
      now: at('2026-10-24T10:00:00'),
    });
    expect(d.speak).toBe(false);
    expect(d.suppressedBy).toBe('noTemplate');
  });

  it('6 小时内第二次欠费不说话（否则持续欠费会变成刷屏）', () => {
    const now = at('2026-10-24T12:00:00');
    const d = decideSpeak('longOutage', {
      spokenAt: [at('2026-10-24T10:00:00')],
      hasTemplate: true,
      now,
    });
    expect(d.speak).toBe(false);
    expect(d.suppressedBy).toBe('tooSoon');
  });

  it('超过最小间隔后可以再说一次，但受全天次数限制', () => {
    const limits = FALLBACK_SPEAK_LIMITS.longOutage;
    const first = at('2026-10-24T02:00:00');
    const now = new Date(first.getTime() + limits.minIntervalMs);

    const allowed = decideSpeak('longOutage', {
      spokenAt: [first],
      hasTemplate: true,
      now,
    });
    expect(allowed.speak).toBe(true);

    // 同一天已经有 2 次 → 第三次必须被拦
    const third = decideSpeak('longOutage', {
      spokenAt: [first, now],
      hasTemplate: true,
      now: new Date(now.getTime() + limits.minIntervalMs),
    });
    expect(third.speak).toBe(false);
    expect(third.suppressedBy).toBe('dailyLimit');
  });

  it('跨天后次数重置', () => {
    const limits = FALLBACK_SPEAK_LIMITS.longOutage;
    const spokenAt = [at('2026-10-23T09:00:00'), at('2026-10-23T20:00:00')];
    const d = decideSpeak('longOutage', {
      spokenAt,
      hasTemplate: true,
      now: at('2026-10-24T09:00:00'),
    });
    expect(d.speak).toBe(true);
  });

  it('我方限额一天只回一次（语义是"今天累了"）', () => {
    const first = at('2026-10-24T09:00:00');
    const second = decideSpeak('budgetLimit', {
      spokenAt: [first],
      hasTemplate: true,
      now: at('2026-10-24T15:00:00'),
    });
    expect(second.speak).toBe(false);
    expect(second.suppressedBy).toBe('dailyLimit');
  });

  it('抖动比欠费宽松（分钟级故障该说就说）', () => {
    expect(FALLBACK_SPEAK_LIMITS.shortOutage.minIntervalMs).toBeLessThan(
      FALLBACK_SPEAK_LIMITS.longOutage.minIntervalMs,
    );
    expect(FALLBACK_SPEAK_LIMITS.shortOutage.maxPerDay).toBeGreaterThan(
      FALLBACK_SPEAK_LIMITS.longOutage.maxPerDay,
    );
  });

  it('未来的时间点（时钟漂移）不会被当成 "刚说过"', () => {
    const d = decideSpeak('longOutage', {
      spokenAt: [at('2026-10-25T10:00:00')],
      hasTemplate: true,
      now: at('2026-10-24T10:00:00'),
    });
    expect(d.speak).toBe(true);
  });
});
