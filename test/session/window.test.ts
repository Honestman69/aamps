import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WINDOW_LIMITS,
  buildWindow,
  flattenWindow,
  windowQuoteFacts,
  type WindowLimits,
  type WindowMessage,
} from '@/modules/session/window';

const NOW = new Date('2026-10-24T12:00:00');

let seq = 0;
const msg = (senderId: string, secondsAgo: number, content = '话'): WindowMessage => {
  seq += 1;
  return {
    id: `m-${seq}`,
    role: senderId === 'bot' ? 'assistant' : 'user',
    senderId,
    senderName: senderId,
    content,
    createdAt: new Date(NOW.getTime() - secondsAgo * 1000),
  };
};

/** 按"越靠前越老"的顺序造一串消息 */
function series(count: number, stepSeconds = 5, senderId = 'peer'): WindowMessage[] {
  return Array.from({ length: count }, (_, i) => msg(senderId, (count - i) * stepSeconds));
}

const limits = (overrides: Partial<WindowLimits> = {}): WindowLimits => ({
  maxMessages: 5,
  maxAgeMs: 60 * 60 * 1000,
  maxChars: 1000,
  ...overrides,
});

describe('target 必须在窗口里（这是窗口的第一条规则）', () => {
  it('回复的那条很早、后面刷了很多条 → 仍然在窗口里', () => {
    const messages = series(30);
    const target = messages[2] as WindowMessage; // 第 3 条，后面还有 27 条

    const window = buildWindow({ targetId: target.id, messages, limits: limits(), now: NOW });

    expect(window).not.toBeNull();
    expect(window?.target.id).toBe(target.id);
    // after 只留得下 4 条（maxMessages 5 含 target），丢的是**最老的**中间部分
    expect(window?.after).toHaveLength(4);
    expect(window?.before).toHaveLength(0);
    expect(window?.dropped.after).toBe(23);
  });

  it('target 不在消息里 → 返回 null，不拿别的消息硬凑', () => {
    const messages = series(5);
    const window = buildWindow({ targetId: 'not-exist', messages, limits: limits(), now: NOW });
    expect(window).toBeNull();
  });

  it('会话里只有 target 自己 → 前后都空，但仍然是一个有效窗口', () => {
    const messages = series(1);
    const window = buildWindow({
      targetId: (messages[0] as WindowMessage).id,
      messages,
      limits: limits(),
      now: NOW,
    });
    expect(window?.before).toEqual([]);
    expect(window?.after).toEqual([]);
    expect(window?.afterTotals.count).toBe(0);
  });
});

describe('after 优先于 before（缺背景还能聊，缺直接语境就答歪）', () => {
  it('条数预算满时先砍 before，after 全保留', () => {
    // 10 条：target 是倒数第 3 条，after 有 2 条
    const messages = series(10);
    const target = messages[7] as WindowMessage;

    const window = buildWindow({ targetId: target.id, messages, limits: limits(), now: NOW });

    expect(window?.after).toHaveLength(2);
    // 5 - 1 - 2 = 2 条 before
    expect(window?.before).toHaveLength(2);
    expect(window?.dropped.before).toBe(5);
  });

  it('after 自己就超预算时，before 一条都不给', () => {
    const messages = series(10);
    const target = messages[0] as WindowMessage; // after 有 9 条

    const window = buildWindow({ targetId: target.id, messages, limits: limits(), now: NOW });

    expect(window?.before).toEqual([]);
    expect(window?.after).toHaveLength(4); // 5 - 1
  });

  it('after 保留的是最近的（从尾部取），不是最老的那几条', () => {
    const messages = series(10);
    const target = messages[0] as WindowMessage;

    const window = buildWindow({ targetId: target.id, messages, limits: limits(), now: NOW });

    const kept = window?.after.map((message) => message.id) ?? [];
    const expected = messages.slice(-4).map((message) => message.id);
    expect(kept).toEqual(expected);
  });
});

describe('时间边界：只约束 before，不约束 after', () => {
  it('超过 maxAgeMs 的 before 被丢掉，即使条数还够', () => {
    const old = msg('peer', 7200); // 2 小时前
    const recent1 = msg('peer', 30);
    const recent2 = msg('peer', 20);
    const target = msg('peer', 10);
    const messages = [old, recent1, recent2, target];

    const window = buildWindow({
      targetId: target.id,
      messages,
      limits: limits({ maxMessages: 10, maxAgeMs: 60 * 60 * 1000 }),
      now: NOW,
    });

    expect(window?.before.map((message) => message.id)).toEqual([recent1.id, recent2.id]);
    expect(window?.dropped.before).toBe(1);
  });

  it('target 本身很老也不被丢（隔了很久才回也算有效回应）', () => {
    const target = msg('peer', 3 * 60 * 60); // 3 小时前
    const later = msg('peer', 60);
    const messages = [target, later];

    const window = buildWindow({
      targetId: target.id,
      messages,
      limits: limits({ maxAgeMs: 60 * 60 * 1000 }),
      now: NOW,
    });

    expect(window?.target.id).toBe(target.id);
    // after 不按时间裁，所以 1 小时前那条仍然在
    expect(window?.after).toHaveLength(1);
  });
});

describe('字符预算', () => {
  it('超预算后整体停下，不跳过大的去取小的（避免上下文挖洞）', () => {
    const a = msg('peer', 50, 'a'.repeat(10));
    const big = msg('peer', 40, 'b'.repeat(500)); // 超预算
    const c = msg('peer', 30, 'c'.repeat(10));
    const target = msg('peer', 10, 'target');
    const messages = [a, big, c, target];

    const window = buildWindow({
      targetId: target.id,
      messages,
      limits: limits({ maxMessages: 10, maxChars: 100 }),
      now: NOW,
    });

    // 从尾往前：c 进（10 字），big 超预算 → break。a 不会因为 big 被跳过而被取到
    expect(window?.before.map((m) => m.content)).toEqual(['c'.repeat(10)]);
  });

  it('单条 after 就超预算时，after 为空但统计仍然完整', () => {
    const target = msg('peer', 30);
    const huge = msg('other', 20, 'x'.repeat(2000));
    const messages = [target, huge];

    const window = buildWindow({
      targetId: target.id,
      messages,
      limits: limits({ maxChars: 100 }),
      now: NOW,
    });

    expect(window?.after).toEqual([]);
    // 关键：窗口里没有它，但"有 1 条、1 个人在说"这个事实不能丢
    expect(window?.afterTotals.count).toBe(1);
    expect(window?.afterTotals.distinctSenders).toBe(1);
  });
});

describe('afterTotals 基于未裁剪的消息（引用决策靠它）', () => {
  it('after 被裁到 4 条，但统计仍是全量', () => {
    const messages = [
      msg('peer', 100),
      ...Array.from({ length: 20 }, (_, i) => msg(i % 2 === 0 ? 'a' : 'b', 90 - i)),
    ];
    const target = messages[0] as WindowMessage;

    const window = buildWindow({ targetId: target.id, messages, limits: limits(), now: NOW });

    expect(window?.after).toHaveLength(4);
    expect(window?.afterTotals.count).toBe(20);
    expect(window?.afterTotals.distinctSenders).toBe(2);
  });

  it('lastAt 取最后一条 after 的时间', () => {
    const messages = series(5);
    const target = messages[1] as WindowMessage;
    const window = buildWindow({
      targetId: target.id,
      messages,
      limits: limits({ maxMessages: 10 }),
      now: NOW,
    });
    expect(window?.afterTotals.lastAt).toEqual(messages[4]?.createdAt);
  });
});

describe('与引用决策的接缝', () => {
  it('windowQuoteFacts 给出未裁剪的统计（窗口裁过也不会误判）', () => {
    const messages = [
      msg('peer', 500),
      ...Array.from({ length: 30 }, (_, i) => msg(i % 3 === 0 ? 'a' : 'b', 400 - i)),
    ];
    const target = messages[0] as WindowMessage;

    const window = buildWindow({ targetId: target.id, messages, limits: limits(), now: NOW });
    const facts = windowQuoteFacts(window as NonNullable<typeof window>);

    expect(facts.after.length).toBeLessThanOrEqual(4);
    expect(facts.afterTotals.count).toBe(30);
    expect(facts.afterTotals.distinctSenders).toBe(2);
    expect(facts.target.id).toBe(target.id);
  });
});

describe('flattenWindow 的顺序', () => {
  it('按时间铺平：before → target → after', () => {
    const messages = series(6);
    const target = messages[3] as WindowMessage;

    const window = buildWindow({
      targetId: target.id,
      messages,
      limits: limits({ maxMessages: 10 }),
      now: NOW,
    });
    const flat = flattenWindow(window as NonNullable<typeof window>);

    expect(flat.map((message) => message.id)).toEqual(messages.map((message) => message.id));
    expect(flat.indexOf(target)).toBe(3);
  });
});

describe('默认预算', () => {
  it('群聊给得比私聊宽（人多、同样时间消息更多）', () => {
    expect(DEFAULT_WINDOW_LIMITS.group.maxMessages).toBeGreaterThan(
      DEFAULT_WINDOW_LIMITS.private.maxMessages,
    );
    expect(DEFAULT_WINDOW_LIMITS.group.maxChars).toBeGreaterThan(
      DEFAULT_WINDOW_LIMITS.private.maxChars,
    );
  });

  it('私聊默认约 10 轮对话（20 条）', () => {
    expect(DEFAULT_WINDOW_LIMITS.private.maxMessages).toBe(20);
  });
});
