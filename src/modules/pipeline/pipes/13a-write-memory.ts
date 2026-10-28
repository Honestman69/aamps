/**
 * ⑬a 反思写入（M5-1 / D045）。
 *
 * 放在最后一步（`persist-interaction` 之后）有两个原因：
 *   1. 只有真的回完了，这段对话才算"发生过"，值得总结；
 *   2. 反思要额外调一次模型（`purpose: 'reflection'`，走 `modelCheap`），
 *      放在出站之后，它的耗时不会拖慢对方收到回复。
 *
 * ## 这一步绝不能抛异常
 *
 * 它跑在消息已经发出去之后：抛出去会被编排层当成故障 → 触发兜底话术 →
 * **对方收到第二条消息**（而且是一条莫名其妙的"我这会儿有点问题"）。
 * `maybeReflect` 内部已经吞掉所有错误（见 `memory.service.ts` 文件头），
 * 这里再挂一行 `.catch` 作为护栏 —— 防的是将来换实现时把这层契约弄丢。
 */

import type { Pipe } from './types';

export const writeMemoryPipe: Pipe = {
  name: 'write-memory',
  requires: ['message', 'session', 'owner', 'now'],
  provides: [],
  async run(ctx) {
    await ctx.deps.memory
      .maybeReflect({
        instanceId: ctx.message.instanceId,
        ownerUserId: ctx.owner.ownerUserId,
        sessionId: ctx.session.id,
        subjectId: ctx.message.sender.id,
        now: ctx.now,
      })
      .catch(() => undefined);
  },
};
