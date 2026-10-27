/**
 * ① 落库：会话 + 入站消息。
 *
 * 为什么最先做：后面每一步都可能 `DROP`（治理、不看、窗口空），
 * 而"用户说过这句话"这个事实**无论回不回都要留下**。
 */

import type { Pipe } from './types';

export const persistInboundPipe: Pipe = {
  name: 'persist-inbound',
  requires: [],
  provides: ['now', 'session', 'inbound'],
  async run(ctx) {
    // 处理时刻只取一次：后面所有判断（衰减、延迟、引用）都用同一个 now，
    // 避免"读的时候 10:00:00、判断的时候 10:00:01"这类不可复现的差异
    ctx.now = ctx.deps.clock?.() ?? new Date();

    ctx.session = await ctx.deps.sessions.ensureSession({
      instanceId: ctx.message.instanceId,
      kind: ctx.message.session.kind,
      peerId: ctx.message.session.peerId,
      peerName: ctx.message.sender.name,
    });

    ctx.inbound = await ctx.deps.sessions.saveInbound({
      sessionId: ctx.session.id,
      message: ctx.message,
    });
  },
};
