/**
 * ④a 入站约束词（D051）：这条消息命中 owner 配的"别聊这个"就不接。
 *
 * 放在 `governance` 之后、`load-mind` 之前：
 *   - 静默/人工接管优先（那是更硬的规则，命中就不该再往下算）；
 *   - 命中规则立刻 DROP —— 后面的读状态、取窗口、拼 prompt、调模型全都不做（省 token）。
 *
 * 消息在 ① 已经入库，这里只补一个 `blocked` 标记：会话查看里要能看出
 * "这条被规则拦了，不是它没看见"。
 *
 * 失败语义：读规则失败 = 没有规则（`RuleService.activeRules` 已吞）。拦错一次的代价
 * 是"该拦的没拦住"，比"规则表抖一下它就彻底不说话"小得多。
 */

import { DROP } from '@newjob/contracts';

import { blockReasonOf, matchRule } from '../../rules/match';
import type { Pipe } from './types';

export const guardInputPipe: Pipe = {
  name: 'guard-input',
  requires: ['message', 'inbound'],
  provides: [],
  async run(ctx) {
    if (!ctx.message.plainText) {
      return;
    }
    const rules = await ctx.deps.rules.activeRules(ctx.message.instanceId);
    const hit = matchRule(ctx.message.plainText, rules, 'input_block');
    if (!hit) {
      return;
    }
    await ctx.deps.sessions
      .markBlocked(ctx.inbound.id, blockReasonOf(hit))
      .catch(() => undefined);
    return DROP;
  },
};
