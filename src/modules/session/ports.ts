/**
 * 会话窗口的取数端口。
 *
 * 这一层的存在是因为 `buildWindow` 是纯函数，它假设"消息都在手里"。
 * 而真实取数有两条约束：
 *   1. **target 可能很老**，不在"最近 N 条"里 —— 所以必须按 target 定位，不能只取最近 N 条；
 *   2. **after 的总数可能很大**（群里刷了几百条），不能全拉进内存统计 —— count 与
 *      发言人数必须在数据库端算，否则窗口裁剪之后就再也算不准了。
 */

import type { WindowMessage } from './window';

export type WindowSlice = {
  target: WindowMessage;
  /** target 之前，时间升序 */
  before: WindowMessage[];
  /** target 之后，时间升序 */
  after: WindowMessage[];
  /** 基于**全量** after（不只是取出来的那部分） */
  afterTotals: { count: number; distinctSenders: number };
};

export interface ISessionWindowRepository {
  /**
   * 取 target 及其前后切片。
   *
   * @param beforeLimit 往前取多少条（建议给窗口 `maxMessages` 的 2 倍，让裁剪逻辑自己砍）
   * @param afterLimit  往后取多少条（同上）
   * @returns `null` 表示 target 不存在，或不属于该会话 —— 两种都不该继续回复
   */
  loadSlice(input: {
    sessionId: string;
    targetMessageId: string;
    beforeLimit: number;
    afterLimit: number;
  }): Promise<WindowSlice | null>;
}
