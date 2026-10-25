import { describe, expect, it } from 'vitest';

import { DEFAULT_DELAY_POLICY, clampTotalDelays, isLateNight, readDelayMs, typingDelayMs } from '@/modules/mind/expression/delay';
import { DEFAULT_EXPRESSION_POLICY, parseExpressionPolicy, planTextReply } from '@/modules/mind/expression/plan';
import { messageSeed, seededRand } from '@/modules/mind/expression/rand';
import { DEFAULT_SPLIT_POLICY, splitMessage } from '@/modules/mind/expression/split';

const DAY = new Date('2026-10-25T14:00:00');
const NIGHT = new Date('2026-10-25T02:00:00');

describe('splitMessage', () => {
  it('短回复不拆：一句"嗯"拆成两条更假', () => {
    expect(splitMessage('嗯嗯，好', DEFAULT_SPLIT_POLICY, () => 0)).toEqual(['嗯嗯，好']);
  });

  it('长回复按句切开，且一条都不少', () => {
    const text =
      '今天下班路上看到一只橘猫蹲在便利店门口，特别胖。' +
      '它一直盯着我手里的关东煮，我就分了一小块鱼丸给它。' +
      '结果它吃完就跑了，一点情面都不给。';
    const parts = splitMessage(text, DEFAULT_SPLIT_POLICY, () => 0);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.length).toBeLessThanOrEqual(DEFAULT_SPLIT_POLICY.maxSegments);
    // 绝不丢内容：拼回去要和原文一致（只差空白）
    expect(parts.join('')).toBe(text);
  });

  it('splitChance 为 0 时整段发', () => {
    const text = '第一句比较长一点。第二句也挺长的。第三句也不短。';
    expect(splitMessage(text, { ...DEFAULT_SPLIT_POLICY, splitChance: 0 }, () => 0)).toEqual([text]);
  });

  it('单句超长时硬切，但每段仍尽量接近上限', () => {
    const text = '啊'.repeat(100);
    const parts = splitMessage(text, { ...DEFAULT_SPLIT_POLICY, maxSegments: 6 }, () => 0);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('')).toBe(text);
  });

  it('换行被当成强制停顿', () => {
    const text = '第一行说了点东西。\n第二行又说了一句。';
    const parts = splitMessage(text, DEFAULT_SPLIT_POLICY, () => 0);
    expect(parts).toEqual(['第一行说了点东西。', '第二行又说了一句。']);
  });

  it('超过条数上限时把尾部并进最后一条，而不是丢弃', () => {
    const text = ['一句话。', '两句话。', '三句话。', '四句话。', '五句话。'].join('');
    const parts = splitMessage(text, { maxCharsPerSegment: 5, maxSegments: 2, splitChance: 1 }, () => 0);
    expect(parts).toHaveLength(2);
    expect(parts.join('')).toBe(text);
  });

  it('同一段文本重放得到同样的拆法（种子固定）', () => {
    const text = '今天天气不错。想出去走走。你那边下雨了吗。';
    const a = splitMessage(text, DEFAULT_SPLIT_POLICY, seededRand(messageSeed('s1', 'm1')));
    const b = splitMessage(text, DEFAULT_SPLIT_POLICY, seededRand(messageSeed('s1', 'm1')));
    expect(a).toEqual(b);
  });
});

describe('延迟', () => {
  it('首条 = 0.8s + 字数 × 0.05s（抖动为 1 时）', () => {
    // rand = 0.5 → 抖动系数 1.0
    expect(readDelayMs(20, { busy: false, now: DAY }, DEFAULT_DELAY_POLICY, () => 0.5)).toBe(1800);
  });

  it('抖动在 ±30% 之间', () => {
    const low = readDelayMs(0, { busy: false, now: DAY }, DEFAULT_DELAY_POLICY, () => 0);
    const high = readDelayMs(0, { busy: false, now: DAY }, DEFAULT_DELAY_POLICY, () => 0.999);
    expect(low).toBe(560); // 800 * 0.7
    expect(high).toBe(1040); // 800 * 1.3
  });

  it('忙碌 ×3、深夜 ×1.6，且只乘不减', () => {
    const normal = readDelayMs(10, { busy: false, now: DAY }, DEFAULT_DELAY_POLICY, () => 0.5);
    const busy = readDelayMs(10, { busy: true, now: DAY }, DEFAULT_DELAY_POLICY, () => 0.5);
    const night = readDelayMs(10, { busy: false, now: NIGHT }, DEFAULT_DELAY_POLICY, () => 0.5);
    expect(busy).toBe(normal * 3);
    expect(night).toBe(Math.round(normal * 1.6));
  });

  it('后续每条按 4.5 字/秒算', () => {
    expect(typingDelayMs(45, { busy: false, now: DAY })).toBe(10_000);
    expect(typingDelayMs(9, { busy: false, now: DAY })).toBe(2_000);
  });

  it('深夜判定是 23:00~07:00', () => {
    expect(isLateNight(new Date('2026-10-25T23:30:00'))).toBe(true);
    expect(isLateNight(new Date('2026-10-25T06:59:00'))).toBe(true);
    expect(isLateNight(new Date('2026-10-25T07:00:00'))).toBe(false);
    expect(isLateNight(new Date('2026-10-25T22:59:00'))).toBe(false);
  });

  it('总延迟超上限时按比例压缩，而不是丢消息', () => {
    const compressed = clampTotalDelays([6000, 3000, 3000], 6000);
    expect(compressed.reduce((a, b) => a + b, 0)).toBe(6000);
    expect(compressed[0]).toBe(3000);
    expect(clampTotalDelays([100, 200], 6000)).toEqual([100, 200]);
  });
});

describe('planTextReply', () => {
  const base = {
    text: '好呀。明天见。',
    channel: 'private' as const,
    isMentioned: false,
    senderId: 'peer-1',
    quoted: false,
    ctx: { busy: false, now: DAY },
    policy: DEFAULT_EXPRESSION_POLICY,
    rand: () => 0,
  };

  it('群里被 @：第一条带 @，后面几条不带', () => {
    const parts = planTextReply({
      ...base,
      channel: 'group',
      isMentioned: true,
      text: '来啦来啦，刚才一直在忙别的事情，手机都放兜里没看。现在总算能坐下来跟你聊两句了，今天怎么样？',
    });
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]?.mentionUserId).toBe('peer-1');
    expect(parts.slice(1).every((part) => part.mentionUserId === null)).toBe(true);
  });

  it('已经引用回复时不再 @（避免重复提醒）', () => {
    const parts = planTextReply({ ...base, channel: 'group', isMentioned: true, quoted: true });
    expect(parts.every((part) => part.mentionUserId === null)).toBe(true);
  });

  it('私聊不 @', () => {
    const parts = planTextReply({ ...base, isMentioned: true });
    expect(parts[0]?.mentionUserId).toBeNull();
  });

  it('每条都有自己的延迟：第一条是阅读时间，后面是打字时间', () => {
    const parts = planTextReply({
      ...base,
      text: '第一句就写得比较长一些，多说了几个字，还带了一点点细节。第二句也不算短，说了点别的。',
    });
    expect(parts).toHaveLength(2);

    const readBase = DEFAULT_DELAY_POLICY.readBaseMs + parts[0]!.text.length * DEFAULT_DELAY_POLICY.readPerCharMs;
    // 首条至少是阅读时间的下限（抖动最少 0.7）
    expect(parts[0]!.delayMs).toBeGreaterThanOrEqual(Math.round(readBase * 0.7));
    // 后续按 4.5 字/秒
    expect(parts[1]!.delayMs).toBe(
      typingDelayMs(parts[1]!.text.length, { busy: false, now: DAY }, DEFAULT_DELAY_POLICY),
    );
  });

  it('空文本不产出任何一条', () => {
    expect(planTextReply({ ...base, text: '   ' })).toEqual([]);
  });
});

describe('parseExpressionPolicy', () => {
  it('空值与坏数据回落默认', () => {
    expect(parseExpressionPolicy(null)).toEqual(DEFAULT_EXPRESSION_POLICY);
    expect(parseExpressionPolicy('{')).toEqual(DEFAULT_EXPRESSION_POLICY);
    expect(parseExpressionPolicy('{"expression": 1}')).toEqual(DEFAULT_EXPRESSION_POLICY);
  });

  it('只覆盖写了的字段', () => {
    const policy = parseExpressionPolicy(JSON.stringify({ expression: { typingCps: 6 } }));
    expect(policy.delay.typingCps).toBe(6);
    expect(policy.split.maxSegments).toBe(DEFAULT_SPLIT_POLICY.maxSegments);
  });

  it('越界值逐字段回落，不连累其它字段', () => {
    const policy = parseExpressionPolicy(
      JSON.stringify({ expression: { typingCps: 0, maxSegments: 99, splitChance: 0.2 } }),
    );
    expect(policy.delay.typingCps).toBe(DEFAULT_DELAY_POLICY.typingCps);
    expect(policy.split.maxSegments).toBe(DEFAULT_SPLIT_POLICY.maxSegments);
    expect(policy.split.splitChance).toBe(0.2);
  });

  it('mentionBack 可以关掉', () => {
    const policy = parseExpressionPolicy(JSON.stringify({ expression: { mentionBack: false } }));
    expect(policy.mentionBack).toBe(false);
  });
});
