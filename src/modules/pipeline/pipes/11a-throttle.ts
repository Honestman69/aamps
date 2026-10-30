/**
 * ⑪a 出站节流（M6-2 / D049）。
 *
 * 放在 `deliver` **之前**、`decide-quote` 之后：此时正文已经生成完毕（相似内容要拿正文判），
 * 但还没碰平台。三条强制上限与一条节奏冷却都在这里判：
 *
 * | 情况 | 处理 |
 * |---|---|
 * | 单会话一小时超 40 条 / 单实例当天超上限 | **DROP**（这一次不说；消息已入库，人能查到它本来想说什么） |
 * | 24 小时内同一句话已经说过 3 次 | **DROP**（复读机是最大的机器特征） |
 * | 连续说了 5 条 | 等冷却剩下的时间再发（真人也是一句一句打的） |
 *
 * 为什么超限是"不说"而不是"排队"：排队等于半小时后补发一句"哈哈"，
 * 那比沉默更像故障。唯一会等的是连续发言的冷却 —— 它属于同一段回复的节奏。
 */

import { DROP } from '@newjob/contracts';

import type { Pipe } from './types';

export const throttlePipe: Pipe = {
  name: 'throttle',
  requires: ['message', 'session', 'config', 'now', 'replyText', 'wait'],
  provides: [],
  async run(ctx) {
    const decision = await ctx.deps.throttle.check({
      instanceId: ctx.message.instanceId,
      sessionId: ctx.session.id,
      text: ctx.replyText,
      now: ctx.now,
      dailyCap: ctx.config.dailyMsgCap,
    });

    if (!decision.allow) {
      // 拒发不算故障：不抛、不走兜底，安静结束（同 attention 的 DROP 语义）
      return DROP;
    }
    if (decision.waitMs > 0) {
      await ctx.wait(decision.waitMs);
    }
  },
};
