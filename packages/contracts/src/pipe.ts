/**
 * 消息管道契约。
 *
 * 入站与出站都是一串 IPipe，按顺序执行，任何一环返回 DROP 即终止。
 * 这是最主要的扩展点：加功能 = 加一个 Pipe，不改主流程。
 *
 * 注意：mind（拟人表现层）也是以 Pipe 形式插进来的，
 * 并且必须可以整体关闭（见 D011）。
 */

import type { SessionKey } from './message';

/** 终止哨兵。用它而不是 null，避免和合法的空返回值混淆 */
export const DROP = Symbol('DROP');
export type Drop = typeof DROP;

export interface MsgContext {
  traceId: string;
  instanceId: string;
  session: SessionKey;
  /**
   * 管道间传值的背包。
   * 用于把 context 阶段加载的配置/记忆/状态传给后续 Pipe，避免重复查库。
   */
  bag: Map<string, unknown>;
}

export interface IPipe<I, O> {
  readonly name: string;
  run(ctx: MsgContext, input: I): Promise<O | Drop>;
}

export function isDrop(value: unknown): value is Drop {
  return value === DROP;
}
