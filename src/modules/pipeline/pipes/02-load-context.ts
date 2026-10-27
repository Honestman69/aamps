/**
 * ② 取 owner + 人设 + 配置。
 *
 * 配置要**提前**拿（不是等到出站才读）：会话开关决定"要不要理",
 * 而"要不要理"必须在调模型之前就知道。
 *
 * `owner` 为空 = 实例已被删：无处可发，也没必要继续（连兜底话术都没地方说）。
 */

import { DROP } from '@newjob/contracts';

import type { Pipe } from './types';

export const loadContextPipe: Pipe = {
  name: 'load-context',
  requires: ['session'],
  provides: ['owner', 'persona', 'config', 'sessionFlags'],
  async run(ctx) {
    const instanceId = ctx.message.instanceId;

    const owner = await ctx.deps.pipeline.findOwner(instanceId);
    if (!owner) {
      return DROP;
    }

    // 两个查询互不依赖，并发取：这条链路每条消息都要走一次
    const [persona, resolved] = await Promise.all([
      ctx.deps.pipeline.findActivePersona(instanceId),
      ctx.deps.config.get(instanceId, { sessionId: ctx.session.id }),
    ]);

    ctx.owner = owner;
    ctx.persona = persona;
    ctx.config = resolved.config;
    ctx.sessionFlags = resolved.sessionFlags;
  },
};
