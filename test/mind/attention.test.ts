import { describe, expect, it } from 'vitest';

import { computeWake, decideAttention, type AttentionInput } from '@/modules/mind/attention/attention';
import { DEFAULT_ATTENTION_POLICY } from '@/modules/mind/attention/policy';

const POLICY = DEFAULT_ATTENTION_POLICY;

function input(overrides: Partial<AttentionInput> = {}): AttentionInput {
  return {
    channel: 'group',
    isMentioned: false,
    state: { energy: 0.8, busy: false },
    affinity: 0,
    followUp: false,
    groupActivity: 0,
    ...overrides,
  };
}

describe('computeWake', () => {
  it('私聊比群聊多一个下限加成', () => {
    const group = computeWake(input(), POLICY);
    const priv = computeWake(input({ channel: 'private' }), POLICY);
    expect(priv.wake - group.wake).toBeCloseTo(POLICY.privateBoost, 5);
  });

  it('精力越低唤醒度越低', () => {
    const fresh = computeWake(input({ state: { energy: 0.9, busy: false } }), POLICY);
    const tired = computeWake(input({ state: { energy: 0.2, busy: false } }), POLICY);
    expect(tired.wake).toBeLessThan(fresh.wake);
  });

  it('忙碌只抬高群聊阈值，不动私聊', () => {
    const busyGroup = computeWake(input({ channel: 'group', state: { energy: 0.8, busy: true } }), POLICY);
    expect(busyGroup.threshold).toBe(POLICY.thresholdBusy);

    const busyPrivate = computeWake(input({ channel: 'private', state: { energy: 0.8, busy: true } }), POLICY);
    expect(busyPrivate.threshold).toBe(POLICY.thresholdPrivate);
  });
});

describe('decideAttention', () => {
  it('群里没被 @、也没人接话 → 不回', () => {
    const d = decideAttention(input(), POLICY);
    expect(d.speak).toBe(false);
    expect(d.reason).toBe('below_threshold');
  });

  it('群里被 @ → 必回（硬规则，精力再低也回）', () => {
    const d = decideAttention(
      input({ isMentioned: true, state: { energy: 0.05, busy: true } }),
      POLICY,
    );
    expect(d.speak).toBe(true);
    expect(d.reason).toBe('mentioned');
  });

  it('群里聊得热 + 在接它的话 + 熟人 → 会插话', () => {
    const d = decideAttention(
      input({
        followUp: true,
        groupActivity: 1,
        affinity: 100,
        state: { energy: 0.9, busy: false },
      }),
      POLICY,
    );
    expect(d.speak).toBe(true);
    expect(d.reason).toBe('above_threshold');
  });

  it('同一条消息，忙碌时就不插话了', () => {
    const base = input({
      followUp: true,
      groupActivity: 1,
      affinity: 100,
      state: { energy: 0.9, busy: false },
    });
    expect(decideAttention(base, POLICY).speak).toBe(true);
    expect(decideAttention({ ...base, state: { energy: 0.9, busy: true } }, POLICY).speak).toBe(false);
  });

  it('私聊平常状态会回', () => {
    expect(decideAttention(input({ channel: 'private' }), POLICY).speak).toBe(true);
  });

  it('私聊但精疲力尽（凌晨 3 点式）→ 可能不回', () => {
    const d = decideAttention(input({ channel: 'private', state: { energy: 0, busy: false } }), POLICY);
    expect(d.speak).toBe(false);
  });

  it('纯函数：同样的输入永远同样的结论', () => {
    const a = decideAttention(input(), POLICY);
    const b = decideAttention(input(), POLICY);
    expect(a).toEqual(b);
  });
});
