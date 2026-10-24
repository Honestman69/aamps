import { describe, expect, it } from 'vitest';

import { decideBudget, exceededLimit, usageRatio, type BudgetState } from '@/modules/model/metering/budget';

const state = (overrides: Partial<BudgetState> = {}): BudgetState => ({
  dailyBudgetCents: 0,
  monthlyBudgetCents: 0,
  budgetPolicy: 'downgrade',
  ...overrides,
});

const usage = (todayCents: number, monthCents = todayCents) => ({ todayCents, monthCents });

const models = (overrides: Partial<{ mainModel: string; cheapModel: string; purpose: 'chat' | 'think' | 'reflection' }> = {}) => ({
  mainModel: 'deepseek-chat',
  cheapModel: 'deepseek-lite',
  purpose: 'chat' as const,
  ...overrides,
});

describe('预算边界（D024）', () => {
  it('两个额度都是 0 时永不超限（新装实例的默认）', () => {
    expect(exceededLimit(state(), usage(999_999))).toBeNull();
    expect(decideBudget(state(), usage(999_999), models())).toEqual({ mode: 'normal' });
  });

  it('花到等于上限就算超（预算是上限，不是"可以花到"）', () => {
    const s = state({ dailyBudgetCents: 500 });
    expect(exceededLimit(s, usage(499))).toBeNull();
    expect(exceededLimit(s, usage(500))).toBe('daily');
  });

  it('日预算没超但月预算超了，报 monthly', () => {
    const s = state({ dailyBudgetCents: 1000, monthlyBudgetCents: 5000 });
    expect(exceededLimit(s, usage(100, 5000))).toBe('monthly');
  });

  it('两个都超时报日预算（更近的那个约束）', () => {
    const s = state({ dailyBudgetCents: 100, monthlyBudgetCents: 200 });
    expect(exceededLimit(s, usage(500, 900))).toBe('daily');
  });

  it('只设了日预算时，月用量再大也不该拦', () => {
    const s = state({ dailyBudgetCents: 1000, monthlyBudgetCents: 0 });
    expect(exceededLimit(s, usage(10, 999_999))).toBeNull();
  });
});

describe('超限后的动作', () => {
  it('policy=block 直接拒绝，不做降级尝试', () => {
    const d = decideBudget(state({ dailyBudgetCents: 100, budgetPolicy: 'block' }), usage(100), models());
    expect(d).toEqual({ mode: 'block', over: 'daily', because: 'policy' });
  });

  it('policy=downgrade 且确实有更便宜的模型 → 降级', () => {
    const d = decideBudget(state({ dailyBudgetCents: 100 }), usage(120), models());
    expect(d).toEqual({ mode: 'downgrade', over: 'daily', model: 'deepseek-lite' });
  });

  it('cheap 与 main 是同一个模型时不能算降级 → 按 block 处理', () => {
    // 否则会一边超支一边假装在省钱，用户永远等不到"限额生效"
    const d = decideBudget(
      state({ dailyBudgetCents: 100 }),
      usage(120),
      models({ cheapModel: 'deepseek-chat' }),
    );
    expect(d).toEqual({ mode: 'block', over: 'daily', because: 'cannotDowngrade' });
  });

  it('本来就在用 cheap（think / reflection）时降无可降 → block', () => {
    const d = decideBudget(
      state({ dailyBudgetCents: 100 }),
      usage(120),
      models({ purpose: 'think' }),
    );
    expect(d).toEqual({ mode: 'block', over: 'daily', because: 'cannotDowngrade' });
  });

  it('cheap 是空白串时不降级（否则会把空模型名发给厂商）', () => {
    const d = decideBudget(
      state({ dailyBudgetCents: 100 }),
      usage(120),
      models({ cheapModel: '   ' }),
    );
    expect(d).toEqual({ mode: 'block', over: 'daily', because: 'cannotDowngrade' });
  });

  it('未超限时不会因为 policy=block 就提前拒绝', () => {
    const d = decideBudget(state({ dailyBudgetCents: 100, budgetPolicy: 'block' }), usage(99), models());
    expect(d).toEqual({ mode: 'normal' });
  });
});

describe('用量比例（后台展示用）', () => {
  it('未设预算时返回 null，不是 0 也不是 1', () => {
    // 返回 0 会被前端画成"用完了"，返回 1 会被画成"已满"，都不对
    expect(usageRatio(100, 0)).toBeNull();
  });

  it('正常区间按比例返回', () => {
    expect(usageRatio(50, 200)).toBe(0.25);
  });

  it('超出后封顶为 1（进度条不该溢出）', () => {
    expect(usageRatio(500, 200)).toBe(1);
  });
});
