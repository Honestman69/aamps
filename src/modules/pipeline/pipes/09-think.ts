/**
 * ⑨ A 阶段：内心独白（D036）。
 *
 * `purpose: 'think'` 走 `modelCheap` 记账 —— "想"比"说"便宜，这是双阶段的前提。
 *
 * **失败一律当没想**：think 是让回复更好的装饰，不是回话的必要条件（D011）。
 * 解析不出 JSON、调用报错、超时，全都退化成 `directedSystem === system`，
 * 后面的生成照常进行。
 *
 * 注意 `messages.slice(1)`：第 0 条是人格 system，A 阶段要换成"人格 + 思考指令"。
 */

import { parseThinkPolicy } from '../../mind/reflection/policy';
import {
  buildDirectorBlock,
  buildThinkSystem,
  parseThink,
  type ThinkResult,
} from '../../mind/reflection/think';
import type { Pipe, PipelineContext } from './types';

async function runThink(ctx: PipelineContext): Promise<ThinkResult | null> {
  try {
    const result = await ctx.deps.gateway.chat({
      instanceId: ctx.message.instanceId,
      ownerUserId: ctx.owner.ownerUserId,
      sessionId: ctx.session.id,
      purpose: 'think',
      messages: [
        { role: 'system', content: buildThinkSystem(ctx.system) },
        ...ctx.messages.slice(1),
      ],
    });
    return parseThink(result.text);
  } catch {
    return null;
  }
}

export const thinkPipe: Pipe = {
  name: 'think',
  requires: ['persona', 'owner', 'session', 'system', 'messages'],
  provides: ['think', 'directedSystem'],
  async run(ctx) {
    const enabled = parseThinkPolicy(ctx.persona?.behaviorJson ?? null).enabled;
    ctx.think = enabled ? await runThink(ctx) : null;

    // 导演指令拼在 system 末尾：它压在人格之上，但不替换人格
    ctx.directedSystem = ctx.think
      ? `${ctx.system}\n\n${buildDirectorBlock(ctx.think)}`
      : ctx.system;
  },
};
