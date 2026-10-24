/**
 * 凭据模块的 Repository 端口。
 *
 * 硬约束（AGENTS.md 规则 5 / SECURITY.md 第 8 节第 2 条）：
 *   **没有 `findById` / `findMany`**。每个方法名都带 `ForUser`，
 *   `userId` 是**必填参数**而不是可选过滤条件 —— 实现方没有"忘了加 where"的机会。
 *
 * 返回类型 `CredentialPublicRow` **刻意不含 `apiKeyEnc`**（SECURITY.md 第 8 节第 3 条）：
 * 列表、详情、更新回参走的是同一个类型，密文因此根本没有机会流到 Controller 层。
 * 这不是遗漏，漏了反而"更方便"，所以在这里写清楚。
 */

/** 对外可见的凭据字段。**没有 `apiKeyEnc`，将来也不许加** */
export type CredentialPublicRow = {
  id: string;
  provider: string;
  label: string;
  ownerLabel: string | null;
  baseUrl: string | null;
  authStyle: string;
  apiVersion: string | null;
  /** `sk-****a1b2`，仅用于界面展示；由 Service 生成后写入 */
  keyMasked: string;
  defaultModel: string | null;
  priority: number;
  enabled: boolean;
  disabledBy: string | null;
  lastCheckedAt: Date | null;
  lastCheckOk: boolean | null;
  lastError: string | null;
  /** 厂商余额（D025）。`null` 表示没查到或不支持，**不要用 0 代替** */
  balanceCents: number | null;
  balanceCurrency: string | null;
  balanceCheckedAt: Date | null;
  balanceSource: string | null;
  /** 熔断冷却截止；期间路由跳过，但配置不动 */
  cooldownUntil: Date | null;
  unavailableReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CredentialCreateInput = {
  tenantId: string;
  ownerUserId: string;
  provider: string;
  label: string;
  ownerLabel?: string | null;
  baseUrl?: string | null;
  authStyle?: string;
  apiVersion?: string | null;
  /** 已用 owner 的 DEK 加密（`dek:v1:` 前缀）。Repository 不接触明文 */
  apiKeyEnc: string;
  keyMasked: string;
  defaultModel?: string | null;
  priority?: number;
  enabled?: boolean;
};

/** 部分更新。`apiKeyEnc` 与 `keyMasked` 必须成对出现（轮换时一起换） */
export type CredentialUpdatePatch = {
  provider?: string;
  label?: string;
  ownerLabel?: string | null;
  baseUrl?: string | null;
  authStyle?: string;
  apiVersion?: string | null;
  defaultModel?: string | null;
  priority?: number;
  enabled?: boolean;
  apiKeyEnc?: string;
  keyMasked?: string;
};

export interface ICredentialRepository {
  createForUser(input: CredentialCreateInput): Promise<CredentialPublicRow>;

  /** 只能列出**自己的**。没有"列出全部"这个方法，管理员也没有 */
  listForUser(userId: string): Promise<CredentialPublicRow[]>;

  /** 跨用户一律返回 `null`，不抛"无权限"，避免"存在但你没权"这种存在性泄漏 */
  findForUser(userId: string, id: string): Promise<CredentialPublicRow | null>;

  /** 更新仅对 owner 生效；非本人记录返回 `null`（等效于不存在） */
  updateForUser(
    userId: string,
    id: string,
    patch: CredentialUpdatePatch,
  ): Promise<CredentialPublicRow | null>;

  deleteForUser(userId: string, id: string): Promise<boolean>;

  /** 配额检查用（M1 起生效） */
  countForUser(userId: string): Promise<number>;
}
