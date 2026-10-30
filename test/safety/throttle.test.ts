import { describe, expect, it } from 'vitest';

import {
  countConsecutive,
  countSimilar,
  decideOutbound,
  normalizeOutboundText,
  OUTBOUND_LIMITS,
  type OutboundRecent,
} from '@/modules/safety/throttle';

const NOW = new Date('2026-10-29T14:00:00');

function recent(overrides: Partial<OutboundRecent> = {}): OutboundRecent {
  return {
    sessionLastHour: 0,
    instanceToday: 0,
    consecutive: 0,
    lastOutboundAt: null,
    similarCount: 0,
    ...overrides,
  };
}

describe('归一化（防复读机要忽略标点与表情）', () => {
  it('去掉空白、中英文标点与 emoji', () => {
    expect(normalizeOutboundText('在吗？')).toBe('在吗');
    expect(normalizeOutboundText('在 吗!!')).toBe('在吗');
    expect(normalizeOutboundText('好的😄')).toBe('好的');
    expect(normalizeOutboundText('「真的吗」')).toBe('真的吗');
  });

  it('长度不足的短句不参与相似判定（"嗯"本来就会重复）', () => {
    const outbound = [{ content: '嗯' }, { content: '嗯' }, { content: '嗯' }, { content: '嗯' }];
    expect(countSimilar(outbound, '嗯')).toBe(0);
    expect(countSimilar(outbound, '嗯嗯嗯嗯')).toBe(0);
  });

  it('忽略标点差异后算同一条（长句才参与判定）', () => {
    const outbound = [
      { content: '在忙什么呢？' },
      { content: '在忙什么呢' },
      { content: '在忙什么呢!' },
    ];
    expect(countSimilar(outbound, '在忙什么呢')).toBe(3);
  });
});

describe('连续发言计数', () => {
  it('从最新往回数，遇到对方就停', () => {
    expect(countConsecutive([{ role: 'assistant' }, { role: 'assistant' }, { role: 'user' }])).toBe(2);
    expect(countConsecutive([{ role: 'user' }, { role: 'assistant' }])).toBe(0);
    expect(countConsecutive([])).toBe(0);
  });
});

describe('能不能发（decideOutbound）', () => {
  it('一切正常 → 放行且不等待', () => {
    expect(decideOutbound({ now: NOW, recent: recent() })).toEqual({ allow: true, waitMs: 0 });
  });

  it('单实例当天到上限 → 拒发（优先于其他判断）', () => {
    const decision = decideOutbound({
      now: NOW,
      recent: recent({ instanceToday: OUTBOUND_LIMITS.perInstancePerDay, sessionLastHour: 99 }),
    });
    expect(decision).toEqual({ allow: false, reason: 'instance-day-limit' });
  });

  it('配置的每日上限优先于常量（dailyMsgCap=10 时第 10 条就停）', () => {
    expect(
      decideOutbound({ now: NOW, recent: recent({ instanceToday: 10 }), dailyCap: 10 }),
    ).toEqual({ allow: false, reason: 'instance-day-limit' });
    // `0` = 不限，回落到常量
    expect(
      decideOutbound({ now: NOW, recent: recent({ instanceToday: 10 }), dailyCap: 0 }),
    ).toEqual({ allow: true, waitMs: 0 });
  });

  it('单会话一小时 40 条 → 拒发', () => {
    expect(
      decideOutbound({
        now: NOW,
        recent: recent({ sessionLastHour: OUTBOUND_LIMITS.perSessionPerHour }),
      }),
    ).toEqual({ allow: false, reason: 'session-hour-limit' });
  });

  it('24h 内同一句已说过 3 次 → 拒发（防复读机）', () => {
    expect(decideOutbound({ now: NOW, recent: recent({ similarCount: 3 }) })).toEqual({
      allow: false,
      reason: 'similar-content',
    });
  });

  it('连续 5 条且刚说完 → 放行但要等剩下的冷却时间', () => {
    const lastOutboundAt = new Date(NOW.getTime() - 10_000); // 10 秒前
    const decision = decideOutbound({
      now: NOW,
      recent: recent({ consecutive: 5, lastOutboundAt }),
    });
    expect(decision).toEqual({ allow: true, waitMs: 20_000 });
  });

  it('连续 5 条但冷却已过 → 立刻放行', () => {
    const lastOutboundAt = new Date(NOW.getTime() - 40_000); // 40 秒前 > 30 秒
    expect(
      decideOutbound({ now: NOW, recent: recent({ consecutive: 5, lastOutboundAt }) }),
    ).toEqual({ allow: true, waitMs: 0 });
  });

  it('连续 4 条不受冷却限制（上限是"5 条之后"）', () => {
    const decision = decideOutbound({
      now: NOW,
      recent: recent({ consecutive: 4, lastOutboundAt: new Date(NOW.getTime() - 1000) }),
    });
    expect(decision).toEqual({ allow: true, waitMs: 0 });
  });
});
