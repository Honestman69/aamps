/**
 * 发言决策需要的信号，从会话窗口里算（M3-2）。
 *
 * 这两个信号刻意都从**已有数据**推，不为它们单独加表或加查询：
 *
 * - `followUp`：target 的前一条是不是自己说的 → "对方在接我的话"
 * - `groupActivity`：最近 10 分钟窗口里有多少条 → "群里现在热不热"
 *
 * 都是启发式，权重也小（groupVibe 默认 0.15）。它们的作用是让判定从"只看有没有 @"，
 * 变成"看这像不像一个正在聊天的地方"，不值得为精度去引入统计模块。
 */

import type { ContextWindow } from '../../session/window';

/** 接话的时间尺度：超过 10 分钟，对方那句多半已经翻篇了 */
export const FOLLOW_UP_WINDOW_MS = 10 * 60 * 1000;

/** 热度的统计窗口 */
export const ACTIVITY_WINDOW_MS = 10 * 60 * 1000;

/** 10 分钟内多少条算"很热闹"。取 12 是因为一个活跃的群大约每 50 秒一句 */
export const ACTIVITY_FULL_COUNT = 12;

export type WindowSignals = {
  followUp: boolean;
  /** 0-1 */
  groupActivity: number;
};

export function computeSignals(window: ContextWindow, now: Date): WindowSignals {
  const previous = window.before[window.before.length - 1];
  const followUp =
    previous !== undefined &&
    previous.role === 'assistant' &&
    window.target.createdAt.getTime() - previous.createdAt.getTime() <= FOLLOW_UP_WINDOW_MS;

  const since = now.getTime() - ACTIVITY_WINDOW_MS;
  const recent = [...window.before, window.target, ...window.after].filter(
    (message) => message.createdAt.getTime() >= since,
  ).length;

  return {
    followUp,
    groupActivity: Math.min(1, recent / ACTIVITY_FULL_COUNT),
  };
}
