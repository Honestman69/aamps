/**
 * 约束词仓储端口（D051）。
 *
 * 和别处一样：**归属校验下推到 SQL**（连 `instance.ownerUserId`），
 * 拿别人的规则 id 只能得到 null。
 */

export type RuleRow = {
  id: string;
  instanceId: string;
  kind: string;
  pattern: string;
  note: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type RuleCreateInput = {
  instanceId: string;
  kind: string;
  pattern: string;
  note?: string | null;
};

export type RulePatch = Partial<{ pattern: string; note: string | null; enabled: boolean }>;

export interface IRuleRepository {
  listForInstance(instanceId: string): Promise<RuleRow[]>;
  /** 系统调用（管道里）：只取启用的，按 kind 过滤在应用层做 */
  listEnabled(instanceId: string): Promise<RuleRow[]>;
  create(input: RuleCreateInput): Promise<RuleRow>;
  /** 归属：规则 → 实例 → owner。不是自己的一律 null */
  findForUser(userId: string, ruleId: string): Promise<RuleRow | null>;
  update(ruleId: string, patch: RulePatch): Promise<RuleRow>;
  delete(ruleId: string): Promise<boolean>;
  /** 实例是否属于这个用户（建规则前校验，避免"借实例 id 往别人身上加规则"） */
  isInstanceOwned(instanceId: string, userId: string): Promise<boolean>;
}
