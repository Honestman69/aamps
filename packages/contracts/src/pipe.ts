/**
 * 消息管道契约 —— **当前未被使用，保留为跨包草案**（D040）。
 *
 * 主服务里的管道实现在 `src/modules/pipeline/pipes/`，用的是自己的 `Pipe` 类型：
 * 上下文是**强类型对象**（`PipelineContext`）而不是下面这个 `bag: Map<string, unknown>`，
 * 并且每个 pipe 声明 `requires` / `provides` 供启动期校验。
 *
 * 为什么不直接用这里这套：弱类型 bag 取值要 `as`，写错字段名编译期不报；
 * 而管道里传的是 `persona` / `window` / `mind` 这种有明确类型的东西。
 *
 * 什么时候启用：真的有"第三方适配器往管道里插一步"的需求时，
 * 把它作为**对外契约**定稿，并让内部实现改为实现它 —— 而不是两套抽象并存。
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
