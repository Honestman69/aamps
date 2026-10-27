/**
 * 入站管道：**顺序即真相**。
 *
 * 这里是一张平铺的清单，不是被拆散的逻辑 —— 想知道"一条消息经过哪些步骤"，
 * 看这 16 行就够了。加一个行为 = 新建一个 pipe 文件 + 在这里插一行。
 *
 * 两条纪律：
 *   1. **顺序靠 `assertPipeGraph` 校验**，不靠注释里的编号。谁把 `attention`
 *      挪到 `generate` 后面，服务启动就报错，而不是等到线上某条消息返回 undefined。
 *   2. **每个 pipe 只做一件事**，且失败语义写在自己文件里（吞掉 / DROP / 抛出）。
 *
 * 失败（抛出）不走 DROP，而由 `PipelineService` 统一交给兜底话术（D028）：
 * 因为"模型挂了"和"这条不该回"是两件事，前者要说话，后者要安静。
 */

import { isDrop } from '@newjob/contracts';

import { persistInboundPipe } from './01-persist-inbound';
import { loadContextPipe } from './02-load-context';
import { governancePipe } from './03-governance';
import { loadMindPipe } from './04-load-mind';
import { loadWindowPipe } from './05-load-window';
import { attentionPipe } from './06-attention';
import { collectMediaPipe } from './07-collect-media';
import { loadMemoryPipe } from './07a-load-memory';
import { loadSelfPipe } from './07b-load-self';
import { assemblePromptPipe } from './08-assemble-prompt';
import { thinkPipe } from './09-think';
import { generatePipe } from './10-generate';
import { decideQuotePipe } from './11-decide-quote';
import { deliverPipe } from './12-deliver';
import { persistInteractionPipe } from './13-persist-interaction';
import { writeMemoryPipe } from './13a-write-memory';
import type { Pipe, PipelineContext } from './types';

export { assertPipeGraph, createContext } from './types';
export type { Channel, Pipe, PipelineContext } from './types';

export const INBOUND_PIPES: readonly Pipe[] = [
  // 落库 → 取上下文 → 治理（这三步任何一步 DROP，都"只入库不说话"）
  persistInboundPipe,
  loadContextPipe,
  governancePipe,
  // 状态与窗口：后面所有判断的输入
  loadMindPipe,
  loadWindowPipe,
  // 省 token 的那一步：判掉就完全不调模型
  attentionPipe,
  // 模型侧：素材 → 记忆/自我 → prompt → 想 → 说
  collectMediaPipe,
  // 两个"读回"都放在 attention 之后：被判掉的消息不值得为它查库
  loadMemoryPipe,
  loadSelfPipe,
  assemblePromptPipe,
  thinkPipe,
  generatePipe,
  // 出站：引用 → 发送 → 回写 → 反思
  decideQuotePipe,
  deliverPipe,
  persistInteractionPipe,
  // 最后一个：攒够条数才真的写，写失败也只丢这一批记忆（绝不触发兜底话术）
  writeMemoryPipe,
];

/**
 * 依次执行管道。返回 `false` 表示中途 `DROP`（这条消息到此为止）。
 *
 * 单独导出的原因：服务层只剩"入队 + 兜底"，而"DROP 是否真的短路"这种语义
 * 能用三个假 pipe 单测，不必为了测它造一整套依赖。
 *
 * 注意：**抛出不会被吞**（这里没有 try）。故障要走兜底话术，DROP 才是安静结束，
 * 两者必须在类型与代码路径上分开。
 */
export async function runPipeChain(
  ctx: PipelineContext,
  pipes: readonly Pipe[] = INBOUND_PIPES,
): Promise<boolean> {
  for (const pipe of pipes) {
    const outcome = await pipe.run(ctx);
    if (isDrop(outcome)) {
      return false;
    }
  }
  return true;
}
