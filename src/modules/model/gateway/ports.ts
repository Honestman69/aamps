/**
 * Gateway 的端口。
 *
 * `listCandidates` 是全项目**唯一**返回 apiKeyEnc 的读取方法之一
 * （另一个是实例的 findForConnect，那是给接入 token 用的）。
 * 密文在这里被解成明文后只存在于本次调用栈上，用完即弃（D003）。
 */

export type GatewayCandidate = {
  credentialId: string;
  provider: string;
  baseUrl: string | null;
  authStyle: string;
  apiVersion: string | null;
  catalogJson: string;
  /** 密文，只允许在本模块内解密 */
  apiKeyEnc: string;
  priority: number;
};

export type UsageRecordInput = {
  instanceId: string;
  credentialId: string;
  ownerUserId: string;
  provider: string;
  model: string;
  tokenIn: number;
  tokenOut: number;
  costCents: number;
  sessionId?: string | null;
  purpose: string;
};

export interface IGatewayRepository {
  /**
   * 列出可用候选 Key（按 priority 升序，跳过冷却中的）。
   * 必须带 ownerUserId：否则会把别人的 Key 拿去用。
   */
  listCandidates(ownerUserId: string): Promise<GatewayCandidate[]>;

  /** 熔断：只写健康层（cooldownUntil / unavailableReason），不动 enabled */
  markCooldown(credentialId: string, reason: string, until: Date): Promise<void>;

  /** 记账：一次调用一行 */
  recordUsage(input: UsageRecordInput): Promise<void>;
}
