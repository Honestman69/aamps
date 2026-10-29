/**
 * 风险巡检的仓储端口（M6-1 / D048）。
 *
 * 读的是 `InstanceEvent`（信号），写的是实例上的结论（`healthScore` / `silentUntil` /
 * `status` / `enabled`）。**不写连接**：进程内的 adapter 只有实例模块知道，由它负责断开。
 */

import type { DegradeAction, RiskSignal } from './health';

export type RiskInstanceRow = {
  id: string;
  status: string;
  silentUntil: Date | null;
  healthScore: number;
};

export interface IRiskRepository {
  /** 需要巡检的实例：启用中的（停用/封禁的不用再算，分数留着看历史） */
  listInstances(): Promise<RiskInstanceRow[]>;

  findInstance(instanceId: string): Promise<RiskInstanceRow | null>;

  /** 归属校验（接口层要用）：拿别人的实例 id 只能得到 false */
  isInstanceOwned(instanceId: string, userId: string): Promise<boolean>;

  /** 按时间**倒序**给信号（连续拦截的判定依赖顺序） */
  listSignals(instanceId: string, since: Date, limit: number): Promise<RiskSignal[]>;

  /**
   * 落结论：分数每次都写；降级动作顺带写 `silentUntil` / `status` / `enabled`，
   * 并追加一条 `InstanceEvent`（`auto_degrade`），让"它为什么忽然不说话了"能查到。
   */
  saveAssessment(input: {
    instanceId: string;
    score: number;
    action: DegradeAction;
    reasons: string[];
    now: Date;
  }): Promise<void>;
}
