/**
 * ③ 治理：人工接管 / 会话静默 → 只入库，不说话，也不动状态。
 *
 * 为什么连状态都不写：人接管期间的对话**不属于"它"的经历**。
 * 记进亲密度会让关系变成"人工客服与客户"的关系，之后它的语气就会错位。
 */

import { DROP } from '@newjob/contracts';

import type { Pipe } from './types';

export const governancePipe: Pipe = {
  name: 'governance',
  requires: ['sessionFlags'],
  provides: [],
  async run(ctx) {
    if (ctx.sessionFlags.aiPaused || ctx.sessionFlags.muted) {
      return DROP;
    }
  },
};
