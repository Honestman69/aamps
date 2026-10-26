/**
 * ④ 心智状态 + 关系。
 *
 * 读的时候就把状态衰减到 `now`（见 helpers 里的说明）。
 * 两者都**吞异常**：状态层坏了最多这几句不像人，对话必须继续（D011）。
 */

import { loadMindState, loadRelationship } from './helpers';
import type { Pipe } from './types';

export const loadMindPipe: Pipe = {
  name: 'load-mind',
  requires: ['now'],
  provides: ['mind', 'relationship'],
  async run(ctx) {
    const instanceId = ctx.message.instanceId;
    ctx.mind = await loadMindState(ctx.deps, instanceId, ctx.now);
    ctx.relationship = await loadRelationship(ctx.deps, instanceId, ctx.message.sender.id);
  },
};
