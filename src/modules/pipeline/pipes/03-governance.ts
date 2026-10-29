/**
 * ③ 治理：人工接管 / 会话静默 / 实例被风控静默 → 只入库，不说话，也不动状态。
 *
 * 为什么连状态都不写：人接管期间的对话**不属于"它"的经历**。
 * 记进亲密度会让关系变成"人工客服与客户"的关系，之后它的语气就会错位。
 *
 * ## 实例级静默（M6-1）为什么也在这一步
 *
 * `silentUntil` 是风控降级的产物（被平台拦了 → 冷却 / 只收不发）。
 * 它必须**早于**所有会发消息的步骤生效，包括 `attention` 与故障兜底：
 * 冷却期间回一句话（哪怕是"我这会儿有点事"），等于继续往枪口上撞。
 * 放在 `governance` 是因为它是"这条消息不该由它回应"的判断，与人工接管同一性质。
 */

import { DROP } from '@newjob/contracts';

import type { Pipe } from './types';

export const governancePipe: Pipe = {
  name: 'governance',
  requires: ['sessionFlags', 'owner', 'now'],
  provides: [],
  async run(ctx) {
    if (ctx.sessionFlags.aiPaused || ctx.sessionFlags.muted) {
      return DROP;
    }
    // 风控静默期：**一个字都不发**（消息在 ① 已入库，可查）
    if (ctx.owner.silentUntil && ctx.owner.silentUntil.getTime() > ctx.now.getTime()) {
      return DROP;
    }
  },
};
