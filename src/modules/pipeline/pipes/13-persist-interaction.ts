/**
 * ⑬ 交互回写：回一条要花精力，情绪由这一轮的内心独白推动（D036）。
 *
 * 放最后的原因：只有"真的发出去了"才算一次交互。
 * 出站中途抛错时这一步不会执行 —— 那也是对的，对方没收到就不该长亲密度。
 */

import { applyReply } from '../../mind/state/mind-state';
import { persistMind, persistRelationship } from './helpers';
import type { Pipe } from './types';

export const persistInteractionPipe: Pipe = {
  name: 'persist-interaction',
  requires: ['mind', 'relationship', 'think', 'now'],
  provides: [],
  async run(ctx) {
    const instanceId = ctx.message.instanceId;

    // emotion_shift 已经在 think 里夹过 ±0.3；没 think 就是 0（不推动，只回归）
    await persistMind(
      ctx.deps,
      instanceId,
      applyReply(ctx.mind, { moodShift: ctx.think?.emotionShift ?? 0 }),
    );
    await persistRelationship(ctx.deps, instanceId, ctx.message, ctx.relationship, ctx.now, true);
  },
};
