/**
 * ⑦b 读回"现在的你"（M5-2 / D046）。
 *
 * 与 `load-memory` 同为"读回"，但读的是两样不同的东西，所以是两个 pipe：
 *   - `load-memory`：它认识谁、聊过什么（关于**别人**）；
 *   - `load-self`：它自己变成了什么样（关于**自己**）。
 * 合在一起写会让"读失败怎么办"的语义打架 —— 记忆读不到该静默，演化读不到也该静默，
 * 但两者的默认值不同（空记忆 vs 中性特质 + 空自述），拆开各自说清楚更省事。
 *
 * 失败语义：**吞掉**。没有演化记录 = 这次只用种子人格，对话照常（D011）。
 */

import { DEFAULT_TRAITS } from '../../persona/self/traits';
import type { Pipe } from './types';

export const loadSelfPipe: Pipe = {
  name: 'load-self',
  requires: ['message'],
  provides: ['selfState'],
  async run(ctx) {
    ctx.selfState = await ctx.deps.self
      .describeForPrompt(ctx.message.instanceId)
      .catch(() => ({ narrative: '', traits: { ...DEFAULT_TRAITS }, lines: [] }));
  },
};
