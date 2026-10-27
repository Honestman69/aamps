/**
 * 人格演化的仓储端口（M5-2）。
 *
 * 归属校验和别处一样**下推到 SQL**（`instance.ownerUserId`），不在应用层"查出来再判断"。
 *
 * `applyVersion` 是**唯一**的写入口，且必须在一个事务里完成"追加快照 + 更新当前状态"：
 * 只写其中一半的后果是"当前状态没有历史"（不可回滚）或"历史里有一版从未生效"，
 * 两者都会让"它为什么变成这样"失去答案。
 */

import type { TraitKey, Traits } from './traits';

export type SelfStateRow = {
  instanceId: string;
  traits: Traits;
  narrative: string;
  version: number;
  updatedAt: Date;
};

export type SelfVersionRow = {
  version: number;
  traits: Traits;
  narrative: string;
  /** 相对上一版的实际变化量 */
  deltas: Partial<Record<TraitKey, number>>;
  reason: string;
  sourceMemoryIds: string | null;
  createdAt: Date;
};

export type ApplyVersionInput = {
  instanceId: string;
  /** 新版本号（历史只增不改，回滚也 +1） */
  version: number;
  traits: Traits;
  narrative: string;
  deltas: Partial<Record<TraitKey, number>>;
  /** reflection | rollback */
  reason: string;
  sourceMemoryIds: string | null;
};

export interface ISelfStateRepository {
  /** 读当前状态；没有返回 null（**不写库**：没演化过就是没演化过） */
  load(instanceId: string): Promise<SelfStateRow | null>;

  /** 归属校验：这个实例属于这个用户吗 */
  isInstanceOwned(instanceId: string, userId: string): Promise<boolean>;

  /** 拿实例的租户与所有者（写审计要用） */
  findInstance(instanceId: string): Promise<{ tenantId: string; ownerUserId: string } | null>;

  /** 今天已累计的变化量（按维度有符号求和），用于单日预算 */
  deltasSince(instanceId: string, since: Date): Promise<Partial<Record<TraitKey, number>>>;

  /** 追加一版快照并更新当前状态（同一事务） */
  applyVersion(input: ApplyVersionInput): Promise<SelfStateRow>;

  /** 版本列表（倒序，最新的在前） */
  listVersions(instanceId: string, limit: number): Promise<SelfVersionRow[]>;

  findVersion(instanceId: string, version: number): Promise<SelfVersionRow | null>;
}
