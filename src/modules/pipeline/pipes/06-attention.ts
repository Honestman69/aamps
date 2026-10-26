/**
 * ⑥ 发言决策（M3 / D032）—— 整条链路里**省钱的那一步**。
 *
 * 位置是刻意的：在调模型之前。自用场景下大部分群消息不该回，
 * 提前判掉既省 token，也避免"有问必答"的客服感（ARCHITECTURE 5）。
 *
 * 判定 `DROP` 时仍要写回状态与关系：
 *   - 状态：把这次衰减持久化，否则"上次衰减"永远停在几小时前；
 *   - 关系：看了不回也涨一点点（`replied: false`），人对"被看着"是有感觉的。
 */

import { DROP } from '@newjob/contracts';

import { decideAttention } from '../../mind/attention/attention';
import { parseAttentionPolicy } from '../../mind/attention/policy';
import { computeSignals } from '../../mind/attention/signals';
import { isBusy } from '../../mind/state/mind-state';
import { persistMind, persistRelationship } from './helpers';
import type { Pipe } from './types';

export const attentionPipe: Pipe = {
  name: 'attention',
  requires: ['window', 'mind', 'relationship', 'persona', 'now'],
  provides: [],
  async run(ctx) {
    const instanceId = ctx.message.instanceId;
    const behaviorJson = ctx.persona?.behaviorJson ?? null;

    const signals = computeSignals(ctx.window, ctx.now);
    const decision = decideAttention(
      {
        channel: ctx.channel,
        isMentioned: ctx.message.isMentioned,
        state: { energy: ctx.mind.energy, busy: isBusy(ctx.mind, ctx.now) },
        affinity: ctx.relationship?.affinity ?? 0,
        followUp: signals.followUp,
        // 私聊没有"群热度"这个概念，传 0 而不是拿私聊消息密度冒充
        groupActivity: ctx.channel === 'group' ? signals.groupActivity : 0,
      },
      parseAttentionPolicy(behaviorJson),
    );

    if (decision.speak) {
      return;
    }

    await persistMind(ctx.deps, instanceId, ctx.mind);
    await persistRelationship(ctx.deps, instanceId, ctx.message, ctx.relationship, ctx.now, false);
    return DROP;
  },
};
