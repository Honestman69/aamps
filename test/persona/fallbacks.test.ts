/**
 * 兜底话术的规则测试。
 *
 * 这些断言防的是"看起来能用、上线才发现很糟"的情况：
 * 空串被当消息发出去、话术里写了运维词、超长话术在群里被拆成刷屏、占位符没人替换。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FALLBACKS,
  FALLBACK_MAX_CHARS,
  parseFallbacks,
  resolveFallback,
  serializeFallbacks,
  validateFallbackText,
  type FallbackTexts,
} from '@/modules/persona/fallbacks';

describe('兜底话术：默认值', () => {
  it('长时故障与群聊默认"不说"（null），不是空串', () => {
    expect(DEFAULT_FALLBACKS.longOutage.private).toBeNull();
    expect(DEFAULT_FALLBACKS.longOutage.group).toBeNull();
    expect(DEFAULT_FALLBACKS.shortOutage.group).toBeNull();
    expect(DEFAULT_FALLBACKS.budgetLimit.group).toBeNull();
  });

  it('默认话术自身必须通过校验（否则默认值就成了非法数据）', () => {
    for (const slot of Object.values(DEFAULT_FALLBACKS)) {
      for (const text of Object.values(slot)) {
        expect(validateFallbackText(text).ok).toBe(true);
      }
    }
  });

  it('默认话术不承诺具体时间（"等下"可以，"十分钟后"不行）', () => {
    const all = Object.values(DEFAULT_FALLBACKS).flatMap((slot) => Object.values(slot));
    for (const text of all) {
      if (text) {
        expect(text).not.toMatch(/\d+\s*(分钟|小时|秒)/);
      }
    }
  });
});

describe('兜底话术：校验', () => {
  it('null 合法，空串非法（空串会变成一条空消息）', () => {
    expect(validateFallbackText(null).ok).toBe(true);
    const result = validateFallbackText('   ');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('null');
    }
  });

  it('超过上限被拒（群聊会被拆条）', () => {
    const long = '啊'.repeat(FALLBACK_MAX_CHARS + 1);
    expect(validateFallbackText(long).ok).toBe(false);
    expect(validateFallbackText('啊'.repeat(FALLBACK_MAX_CHARS)).ok).toBe(true);
  });

  it('链接被拒（防被当广告 / 钓鱼）', () => {
    expect(validateFallbackText('看这个 https://example.com').ok).toBe(false);
    expect(validateFallbackText('去 www.x.com 看看').ok).toBe(false);
  });

  it('运维字眼被拒：这些只能出现在 owner 通知里', () => {
    for (const text of ['余额不足了', '接口限流了', 'Key 失效了', 'API 报错']) {
      const result = validateFallbackText(text);
      expect(result.ok, text).toBe(false);
    }
  });

  it('只允许白名单占位符', () => {
    expect(validateFallbackText('{nickname} 在忙').ok).toBe(true);
    expect(validateFallbackText('{groupName} 的人稍等').ok).toBe(true);
    const bad = validateFallbackText('{foo} 稍等');
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.reason).toContain('占位符');
    }
  });
});

describe('兜底话术：解析与渲染', () => {
  it('库里是 {} 时回落默认值', () => {
    const texts = parseFallbacks('{}');
    expect(texts.shortOutage.private).toBe(DEFAULT_FALLBACKS.shortOutage.private);
    expect(texts.longOutage.private).toBeNull();
  });

  it('非法 JSON 不抛异常（人格数据坏了不能让机器人崩）', () => {
    expect(() => parseFallbacks('{ not json')).not.toThrow();
    expect(parseFallbacks('{ not json').shortOutage.private).toBe(
      DEFAULT_FALLBACKS.shortOutage.private,
    );
  });

  it('显式 null 与"缺项"要区分：前者是用户选择不说', () => {
    const texts = parseFallbacks(JSON.stringify({ shortOutage: { private: null } }));
    expect(texts.shortOutage.private).toBeNull();
    // 没写的槽位仍是默认值
    expect(texts.budgetLimit.private).toBe(DEFAULT_FALLBACKS.budgetLimit.private);
  });

  it('库里的非法话术被忽略，回落默认（宁可说默认话，也不发坏消息）', () => {
    const texts = parseFallbacks(
      JSON.stringify({ shortOutage: { private: '余额不足 https://x.com' } }),
    );
    expect(texts.shortOutage.private).toBe(DEFAULT_FALLBACKS.shortOutage.private);
  });

  it('占位符会被替换；没值时不留半成品', () => {
    const texts: FallbackTexts = {
      ...DEFAULT_FALLBACKS,
      shortOutage: { private: '{nickname} 稍等', group: '{groupName} 稍等' },
    };
    expect(resolveFallback(texts, 'shortOutage', 'private', { nickname: '小明' })).toBe('小明 稍等');
    expect(resolveFallback(texts, 'shortOutage', 'private')).toBe('你 稍等');
    expect(resolveFallback(texts, 'shortOutage', 'group')).toBe('群里 稍等');
  });

  it('null 槽位解析为 null（调用方据此静默）', () => {
    expect(resolveFallback(DEFAULT_FALLBACKS, 'longOutage', 'private')).toBeNull();
  });

  it('序列化前逐条校验，非法就整体拒绝并指出位置', () => {
    const bad: FallbackTexts = {
      ...DEFAULT_FALLBACKS,
      budgetLimit: { private: '余额没了', group: null },
    };
    const result = serializeFallbacks(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems[0]).toMatchObject({ slot: 'budgetLimit', channel: 'private' });
    }
  });
});
