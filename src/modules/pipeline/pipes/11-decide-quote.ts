/**
 * ⑪ 引用决策（D030）。
 *
 * 决定"这条回复要不要引用对方那条"。规则全在这里，模型碰不到 ——
 * 它拿不到 message id，也看不到时序与人数（AGENTS 硬性规则 11）。
 */

import { decideQuote, parseQuoteTendency } from '../../persona/quote';
import { windowQuoteFacts } from '../../session/window';
import type { Pipe } from './types';

export const decideQuotePipe: Pipe = {
  name: 'decide-quote',
  requires: ['window', 'message', 'owner', 'persona', 'now'],
  provides: ['quoteTarget'],
  async run(ctx) {
    const facts = windowQuoteFacts(ctx.window);
    const decision = decideQuote({
      channel: ctx.channel,
      target: facts.target,
      after: facts.after,
      afterTotals: facts.afterTotals,
      incomingQuotesBot: ctx.message.replyToMessageId != null,
      selfId: ctx.owner.accountId,
      tendency: parseQuoteTendency(ctx.persona?.quoteTendency),
      now: ctx.now,
    });

    ctx.quoteTarget = decision.quote ? ctx.message.id : undefined;
  },
};
