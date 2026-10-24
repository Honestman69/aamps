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

  /**
   * 预算用量：返回"今日已花"与"本月已花"（分），按 `instanceId` 聚合。
   *
   * 为什么按实例而不是按 Key：预算是人格的（D024），换 Key 不该刷新额度。
   * 两个时间点由调用方给，仓储不猜时区——"今天"在哪个时区算是业务决定，不是存储决定。
   */
  usageTotals(
    instanceId: string,
    window: { dayStart: Date; monthStart: Date },
  ): Promise<UsageTotals>;
}

export type UsageTotals = {
  todayCents: number;
  monthCents: number;
  /**
   * 本月"记了 0 分"的调用次数。
   *
   * 存在的意义：没配目录价的 Key 会把每次调用都记成 0 分，**预算就永远不会触发**。
   * 这不是"省钱"，是限额静默失效。有了这个计数，网关能在发现时明确说出来。
   */
  unpricedCalls: number;
};
