import { describe, expect, it } from 'vitest';

import {
  MAX_GAP_WITHOUT_QUOTE,
  STALE_AFTER_MS,
  decideQuote,
  parseQuoteTendency,
  stableRoll,
  type QuoteInput,
  type QuoteMessage,
} from '@/modules/persona/quote';

const SELF = 'bot-1';
const PEER = 'peer-1';
const OTHER = 'peer-2';
const NOW = new Date('2026-10-24T12:00:00');

const msg = (id: string, senderId: string, secondsAgo = 0): QuoteMessage => ({
  id,
  senderId,
  createdAt: new Date(NOW.getTime() - secondsAgo * 1000),
});

/** 找一个能让确定性随机落在指定区间的种子 —— 比"跑 100 次看比例"可靠 */
function seedWhere(predicate: (roll: number) => boolean): string {
  for (let i = 0; i < 10_000; i += 1) {
    const candidate = `m-${i}`;
    if (predicate(stableRoll(candidate))) {
      return candidate;
    }
  }
  throw new Error('找不到符合条件的种子');
}

const base = (overrides: Partial<QuoteInput>): QuoteInput => ({
  channel: 'private',
  target: msg('t-1', PEER, 3),
  after: [],
  incomingQuotesBot: false,
  selfId: SELF,
  tendency: 'normal',
  now: NOW,
  ...overrides,
});

describe('禁止引用：引用框出现时反而更怪的情况', () => {
  it('目标是机器人自己说的 → 不引用（引用框里是自己，观感很怪）', () => {
    const d = decideQuote(base({ target: msg('t-1', SELF, 3) }));
    expect(d).toEqual({ quote: false, reason: 'self_quote', probability: null });
  });

  it('私聊里目标就是最后一条 → 不引用（否则一眼就是客服机器人）', () => {
    const d = decideQuote(base({ channel: 'private', after: [] }));
    expect(d.quote).toBe(false);
    expect(d.reason).toBe('redundant');
  });

  it('群聊里目标就是最后一条 → 不引用，哪怕刚才有几个人在说', () => {
    const d = decideQuote(base({ channel: 'group', after: [] }));
    expect(d.quote).toBe(false);
    expect(d.reason).toBe('redundant');
  });

  it('群聊里同一个人连着说、且不超时 → 只有倾向通过才引用', () => {
    const miss = decideQuote(
      base({
        channel: 'group',
        after: [msg('a-1', PEER, 2)],
        tendency: 'never',
      }),
    );
    expect(miss.quote).toBe(false);
    expect(miss.reason).toBe('single_speaker');
  });
});

describe('必要引用：不引用就看不懂在回谁', () => {
  it('对方引用了机器人 → 必引用，优先级高于"紧邻冗余"', () => {
    const d = decideQuote(base({ incomingQuotesBot: true, after: [] }));
    expect(d).toEqual({ quote: true, reason: 'direct_reply', probability: null });
  });

  it('群聊里 target 之后有两个不同人在说 → 必引用', () => {
    const d = decideQuote(
      base({
        channel: 'group',
        after: [msg('a-1', PEER, 2), msg('a-2', OTHER, 1)],
        tendency: 'never',
      }),
    );
    expect(d).toEqual({ quote: true, reason: 'multi_speaker', probability: null });
  });

  it('群聊里目标已经超过 60 秒 → 必引用（上文滚走了）', () => {
    const d = decideQuote(
      base({
        channel: 'group',
        target: msg('t-1', PEER, 90),
        after: [msg('a-1', PEER, 80)],
        tendency: 'never',
      }),
    );
    expect(d.quote).toBe(true);
    expect(d.reason).toBe('stale');
  });

  it('群聊里同一个人连发超过 5 条、回第一条 → 必引用', () => {
    const after = Array.from({ length: MAX_GAP_WITHOUT_QUOTE + 1 }, (_, i) =>
      msg(`a-${i}`, PEER, 10 - i),
    );
    const d = decideQuote(base({ channel: 'group', after, tendency: 'never' }));
    expect(d.quote).toBe(true);
    expect(d.reason).toBe('stale');
  });

  it('私聊里对方连发 3 条、回最早那条 → 必引用（否则不知道在回哪句）', () => {
    const d = decideQuote(
      base({
        channel: 'private',
        after: [msg('a-1', PEER, 2), msg('a-2', PEER, 1)],
        tendency: 'never',
      }),
    );
    expect(d).toEqual({ quote: true, reason: 'multi_message', probability: null });
  });

  it('人格选 never 也不能压掉必要引用（否则群聊会答非所问）', () => {
    const d = decideQuote(
      base({
        channel: 'group',
        after: [msg('a-1', PEER, 2), msg('a-2', OTHER, 1)],
        tendency: 'never',
      }),
    );
    expect(d.quote).toBe(true);
  });
});

describe('倾向区间：引不引用都不歧义，交给人格', () => {
  it('never：中间地带永不主动引用', () => {
    const d = decideQuote(
      base({ channel: 'group', after: [msg('a-1', PEER, 2)], tendency: 'never' }),
    );
    expect(d.quote).toBe(false);
    expect(d.probability).toBe(0);
  });

  it('同一个随机值下，阈值越高越容易命中（验证的是真实的阈值边界）', () => {
    const target = msg('fixed-target', PEER, 3);
    const after = [msg('a-1', PEER, 2)];
    const at = (tendency: 'never' | 'rare' | 'normal' | 'often', seed: string) =>
      decideQuote(base({ channel: 'group', target, after, tendency, seed })).quote;

    // 随机值落在 [0.5, 0.85)：normal(0.5) 不过，often(0.85) 过
    const midSeed = seedWhere((roll) => roll >= 0.5 && roll < 0.85);
    expect(at('normal', midSeed)).toBe(false);
    expect(at('often', midSeed)).toBe(true);

    // 随机值落在 [0.15, 0.5)：rare(0.15) 不过，normal(0.5) 过
    const lowSeed = seedWhere((roll) => roll >= 0.15 && roll < 0.5);
    expect(at('rare', lowSeed)).toBe(false);
    expect(at('normal', lowSeed)).toBe(true);

    // never 的阈值是 0：任何随机值都不过
    expect(at('never', seedWhere((roll) => roll < 0.01))).toBe(false);
  });

  it('倾向通过时 reason = tendency，未通过时说明是哪种"不必要"', () => {
    const hitSeed = seedWhere((roll) => roll < 0.5);
    const missSeed = seedWhere((roll) => roll >= 0.5);

    const hit = decideQuote(
      base({
        channel: 'group',
        after: [msg('a-1', PEER, 2)],
        tendency: 'normal',
        seed: hitSeed,
      }),
    );
    expect(hit).toEqual({ quote: true, reason: 'tendency', probability: 0.5 });

    const miss = decideQuote(
      base({
        channel: 'group',
        after: [msg('a-1', PEER, 2)],
        tendency: 'normal',
        seed: missSeed,
      }),
    );
    expect(miss).toEqual({ quote: false, reason: 'single_speaker', probability: 0.5 });

    // 私聊的中间地带未通过时，原因应是"冗余"而不是"单人"
    const privateMiss = decideQuote(
      base({
        channel: 'private',
        after: [msg('a-1', PEER, 2)],
        tendency: 'normal',
        seed: missSeed,
      }),
    );
    expect(privateMiss.reason).toBe('redundant');
  });
});

describe('确定性：同一个会话同一条消息永远得到同一结果', () => {
  it('同一个种子重复调用结果一致', () => {
    const input = base({ channel: 'group', after: [msg('a-1', PEER, 2)], tendency: 'normal' });
    const first = decideQuote(input);
    const second = decideQuote(input);
    const third = decideQuote(input);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('stableRoll 输出落在 [0,1) 且对同输入稳定', () => {
    for (const seed of ['a', 'target-1', '', '中文种子']) {
      const value = stableRoll(seed);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      expect(stableRoll(seed)).toBe(value);
    }
  });
});

describe('边界', () => {
  it('刚好 60 秒不算超时（边界值不该闪烁）', () => {
    const d = decideQuote(
      base({
        channel: 'group',
        target: msg('t-1', PEER, STALE_AFTER_MS / 1000),
        after: [msg('a-1', PEER, 1)],
        tendency: 'normal',
        seed: seedWhere((roll) => roll >= 0.5),
      }),
    );
    expect(d.reason).not.toBe('stale');
  });

  it('时钟漂移（目标时间在未来）不会被判成"太久之前"', () => {
    const d = decideQuote(
      base({
        channel: 'group',
        target: { id: 't-1', senderId: PEER, createdAt: new Date(NOW.getTime() + 5000) },
        after: [msg('a-1', PEER, 1)],
        tendency: 'normal',
        seed: seedWhere((roll) => roll >= 0.5),
      }),
    );
    expect(d.reason).not.toBe('stale');
  });
});

describe('容错解析（人格数据坏了也不能崩）', () => {
  it('合法值原样返回', () => {
    for (const value of ['never', 'rare', 'normal', 'often'] as const) {
      expect(parseQuoteTendency(value)).toBe(value);
    }
  });

  it('脏值一率回落 normal，而不是报错或不出声', () => {
    for (const bad of [undefined, null, '', 'NORMAL', 'always', 123, {}, []]) {
      expect(parseQuoteTendency(bad)).toBe('normal');
    }
  });
});
