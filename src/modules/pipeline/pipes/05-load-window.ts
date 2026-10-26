/**
 * ⑤ 取上下文窗口（D031）。
 *
 * 两次 `DROP` 的语义不同，但对外一样：
 *   - `loadSlice` 返回 null：这条消息可能刚被删、或不在任何会话里；
 *   - `buildWindow` 返回 null：窗口规则判定它不该进上下文（例如太旧）。
 * 两种情况都不回消息 —— 缺了上下文硬答，比不答更伤。
 */

import { DROP } from '@newjob/contracts';

import { buildWindow, DEFAULT_WINDOW_LIMITS } from '../../session/window';
import type { Pipe } from './types';

export const loadWindowPipe: Pipe = {
  name: 'load-window',
  requires: ['session', 'inbound', 'now'],
  provides: ['window'],
  async run(ctx) {
    const limits = DEFAULT_WINDOW_LIMITS[ctx.channel];
    const slice = await ctx.deps.windowRepo.loadSlice({
      sessionId: ctx.session.id,
      targetMessageId: ctx.inbound.id,
      // 前后都多取一倍：`buildWindow` 自己会按时间与字数裁剪，
      // 取少了会让"刚好越过边界的那条"永远进不来
      beforeLimit: limits.maxMessages * 2,
      afterLimit: limits.maxMessages * 2,
    });
    if (!slice) {
      return DROP;
    }

    const window = buildWindow({
      targetId: ctx.inbound.id,
      messages: [...slice.before, slice.target, ...slice.after],
      limits,
      now: ctx.now,
    });
    if (!window) {
      return DROP;
    }

    ctx.window = window;
  },
};
