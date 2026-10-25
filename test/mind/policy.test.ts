import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ATTENTION_POLICY,
  parseAttentionPolicy,
} from '@/modules/mind/attention/policy';

describe('parseAttentionPolicy', () => {
  it('空值 / 坏 JSON / 非对象一律回落默认', () => {
    expect(parseAttentionPolicy(null)).toEqual(DEFAULT_ATTENTION_POLICY);
    expect(parseAttentionPolicy('{')).toEqual(DEFAULT_ATTENTION_POLICY);
    expect(parseAttentionPolicy('[]')).toEqual(DEFAULT_ATTENTION_POLICY);
    expect(parseAttentionPolicy('{}')).toEqual(DEFAULT_ATTENTION_POLICY);
    expect(parseAttentionPolicy('{"attention": "high"}')).toEqual(DEFAULT_ATTENTION_POLICY);
  });

  it('只覆盖写了的那几个字段，其余保持默认', () => {
    const policy = parseAttentionPolicy(JSON.stringify({ attention: { thresholdGroup: 0.3 } }));
    expect(policy.thresholdGroup).toBe(0.3);
    expect(policy.thresholdPrivate).toBe(DEFAULT_ATTENTION_POLICY.thresholdPrivate);
    expect(policy.weights.mention).toBe(DEFAULT_ATTENTION_POLICY.weights.mention);
  });

  it('非法值逐字段回落，不影响同块其它合法字段', () => {
    const policy = parseAttentionPolicy(
      JSON.stringify({
        attention: {
          // 明显写错：范围外 / 类型不对
          thresholdGroup: 5,
          thresholdPrivate: '0.1',
          base: 0.25,
          weights: { mention: -1, followUp: 0.5, affinity: null },
        },
      }),
    );
    expect(policy.thresholdGroup).toBe(DEFAULT_ATTENTION_POLICY.thresholdGroup);
    expect(policy.thresholdPrivate).toBe(DEFAULT_ATTENTION_POLICY.thresholdPrivate);
    expect(policy.base).toBe(0.25);
    expect(policy.weights.mention).toBe(DEFAULT_ATTENTION_POLICY.weights.mention);
    expect(policy.weights.followUp).toBe(0.5);
    expect(policy.weights.affinity).toBe(DEFAULT_ATTENTION_POLICY.weights.affinity);
  });

  it('只读 attention 段，其它段（expression / rhythm）不影响它', () => {
    const policy = parseAttentionPolicy(
      JSON.stringify({ expression: { splitChance: 0.9 }, rhythm: { activeHours: [8, 24] } }),
    );
    expect(policy).toEqual(DEFAULT_ATTENTION_POLICY);
  });
});
