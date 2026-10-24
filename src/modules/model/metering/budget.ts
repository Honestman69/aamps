/**
 * 预算判定（D024）。
 *
 * 纯函数，无 IO：把"该不该拦、拦了之后用哪个模型"从网关里拆出来，
 * 这样"降级到底有没有真的降"这种事可以穷举测试，不用连数据库。
 *
 * 三个容易做错的地方，都在这里钉死：
 *   1. `0` = 不限，不是"没设"。预算字段的 0 是有意义的值。
 *   2. `downgrade` 只有在**确实能降**的时候才算降级。如果 cheap 和 main 是同一个模型，
 *      或者本来就在用 cheap（think / reflection），那"降级"是假动作 —— 必须按 block 处理，
 *      否则会一边超支一边假装在省钱。
 *   3. 判定用 `>=`：预算是上限，花到等于上限就该停。
 */

import type { BudgetPolicy } from '../../config/types';

export type BudgetUsage = {
  /** 今天已花（分） */
  todayCents: number;
  /** 本月已花（分） */
  monthCents: number;
};

export type BudgetState = {
  dailyBudgetCents: number;
  monthlyBudgetCents: number;
  budgetPolicy: BudgetPolicy;
};

/** 本次调用原本要用哪个模型（chat 用 main，其余用 cheap） */
export type BudgetModels = {
  mainModel: string;
  cheapModel: string;
  /** 本次调用的目的；只有 chat 走 main，才存在"降级"的余地 */
  purpose: 'chat' | 'think' | 'reflection';
};

export type BudgetDecision =
  | { mode: 'normal' }
  | { mode: 'downgrade'; over: 'daily' | 'monthly'; model: string }
  | {
      mode: 'block';
      over: 'daily' | 'monthly';
      /** policy = 用户选了 block；cannotDowngrade = 选了降级但降无可降 */
      because: 'policy' | 'cannotDowngrade';
    };

/** 哪个额度先被突破；都没超返回 null */
export function exceededLimit(state: BudgetState, usage: BudgetUsage): 'daily' | 'monthly' | null {
  // 0 表示不限，永远不超
  if (state.dailyBudgetCents > 0 && usage.todayCents >= state.dailyBudgetCents) {
    return 'daily';
  }
  if (state.monthlyBudgetCents > 0 && usage.monthCents >= state.monthlyBudgetCents) {
    return 'monthly';
  }
  return null;
}

export function decideBudget(
  state: BudgetState,
  usage: BudgetUsage,
  models: BudgetModels,
): BudgetDecision {
  const over = exceededLimit(state, usage);
  if (over === null) {
    return { mode: 'normal' };
  }

  if (state.budgetPolicy === 'block') {
    return { mode: 'block', over, because: 'policy' };
  }

  // policy === 'downgrade'
  const cheap = models.cheapModel.trim();
  const main = models.mainModel.trim();
  const alreadyCheap = models.purpose !== 'chat';
  const noCheaperModel = cheap.length === 0 || cheap === main;

  if (alreadyCheap || noCheaperModel) {
    // 降无可降：继续放行等于"名义限额、实际超支"，比直接停更糟
    return { mode: 'block', over, because: 'cannotDowngrade' };
  }

  return { mode: 'downgrade', over, model: models.cheapModel };
}

/**
 * 用量摘要，用于后台展示与日志。
 *
 * 只做除法与取整，不推断"按当前速度还能用多久"——那种预测在聊天场景里准确率极低，
 * 而错误的预测会让用户按它做决定。
 */
export function usageRatio(usedCents: number, budgetCents: number): number | null {
  if (budgetCents <= 0) {
    return null;
  }
  return Math.min(1, Math.max(0, usedCents / budgetCents));
}
