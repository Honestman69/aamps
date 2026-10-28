/**
 * ⑦a 读回记忆（M5-1 / D045）。
 *
 * 放在 `attention` 之后、`assemble-prompt` 之前，是有意的：
 *   - 在 `attention` 之后 → 被判掉不回的消息不花这次查询；
 *   - 在 `assemble-prompt` 之前 → 拼 system 时要用。
 *
 * 失败语义：**吞掉**。`loadForPrompt` 自己已经 catch 过一层（见 `memory.service.ts`），
 * 这里再挂一行 `.catch` 是护栏而不是重复：这一层失败的代价不是"少记一点"，
 * 而是异常冒到编排层 → 触发兜底话术 → 对方在一条正常回复之后又收到一句莫名其妙的道歉。
 * 护栏比排查这种事故便宜得多（同 D011：装饰层不能变成单点故障）。
 */

import { EMPTY_MEMORY } from '../../memory/types';
import type { Pipe } from './types';

export const loadMemoryPipe: Pipe = {
  name: 'load-memory',
  requires: ['message', 'session'],
  provides: ['memories'],
  async run(ctx) {
    ctx.memories = await ctx.deps.memory
      .loadForPrompt({
        instanceId: ctx.message.instanceId,
        // 摘要按会话取：这个群里聊过什么
        sessionId: ctx.session.id,
        // 事实按人取：这个人怎么样（跨会话成立）
        subjectId: ctx.message.sender.id,
      })
      .catch(() => EMPTY_MEMORY);
  },
};
