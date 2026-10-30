/**
 * ⑩a 出站约束词（D051）：生成的回复命中 owner 配的"别出现这个词"就不发。
 *
 * 放在 `generate` 之后、`decide-quote` 之前：既然要拦，就没必要再算引用与延迟。
 *
 * ## 为什么被拦的回复仍要落库
 *
 * 会话查看里"它本来想说什么"是最有用的证据（M2 就留下了 `Message.blockReason`
 * 的口径：`rule:<id>`）。但**它不进上下文**（`load-window` 查询带 `blocked: false`）——
 * 否则模型下一轮会以为自己说过那句话，语气就错位了。
 *
 * 同理，它也不占限频额度：`listOutbound` 同样过滤 `blocked`。
 */

import { DROP } from '@newjob/contracts';

import { blockReasonOf, matchRule } from '../../rules/match';
import type { Pipe } from './types';

export const guardOutputPipe: Pipe = {
  name: 'guard-output',
  requires: ['replyText', 'message', 'session'],
  provides: [],
  async run(ctx) {
    const rules = await ctx.deps.rules.activeRules(ctx.message.instanceId);
    const hit = matchRule(ctx.replyText, rules, 'output_block');
    if (!hit) {
      return;
    }

    await ctx.deps.sessions
      .saveOutbound({
        sessionId: ctx.session.id,
        content: ctx.replyText,
        senderId: null,
        blocked: true,
        blockReason: blockReasonOf(hit),
      })
      .catch(() => undefined);

    return DROP;
  },
};
