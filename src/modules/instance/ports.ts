/**
 * 实例模块的 Repository 端口。
 *
 * 与凭据一样，**没有 `findById` / `findMany`**：每个方法都带 `userId`。
 * 实例里存着 `accessTokenEnc`（NapCat 的 token），跨用户拿到就是一条能发消息的通道。
 *
 * 唯一能取到密文的方法是 `findForConnect`，它只服务"连接"这一个动作，
 * 并且返回值里没有任何可展示字段 —— 想拿它拼接口响应会很别扭，这是刻意的。
 */

export type InstancePublicRow = {
  id: string;
  name: string;
  platform: string;
  accountId: string;
  adapterType: string;
  /** 连接方向：server = 对方连我们（反向），client = 我们连对方（正向） */
  adapterMode: string;
  endpoint: string | null;
  /** 是否配置了 token（布尔，不是密文） */
  hasAccessToken: boolean;
  enabled: boolean;
  /** 人格预算（分）：0 = 不限；超限策略见 budgetPolicy（D024） */
  dailyBudgetCents: number;
  monthlyBudgetCents: number;
  budgetPolicy: string;
  /** 当前绑定的 Key（id，不是密钥材料）；换 Provider = 改这一项 */
  credentialId: string | null;
  modelMain: string | null;
  modelCheap: string | null;
  modelFallback: string | null;
  modelTemperature: number;
  /** 看图用的模型；null = 不做图片识别（D033） */
  modelVision: string | null;
  /** 语音合成用的 Key / 模型 / 音色；三者任一为空则语音不可用（D033） */
  ttsCredentialId: string | null;
  ttsModel: string | null;
  ttsVoice: string;
  /** 允许转发的图片域名白名单（逗号分隔）；空 = 任意公网 https */
  imageHosts: string;
  /** 主动消息开关（M5-3 / D047） */
  proactiveEnabled: boolean;
  /** 健康分（M6-1 / D048）：0-100，由风控巡检写入 */
  healthScore: number;
  /** 夜间静默时段（M6-2）：`HH:MM-HH:MM` 或 `off` */
  nightQuiet: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

/** 连接时需要的全部材料。离开这个结构，密文没有别的去处 */
export type InstanceConnectConfig = {
  id: string;
  platform: string;
  adapterType: string;
  adapterMode: string;
  accountId: string;
  endpoint: string | null;
  accessTokenEnc: string | null;
  /** 反向模式握手校验用的摘要；没有它就只能在用户解锁后手动连接 */
  accessTokenDigest: string | null;
  enabled: boolean;
};

/**
 * 启动自监听用的行：多一个 ownerUserId（要拿它落状态），没有 actor。
 * 只有系统路径用，不走用户可见接口。
 */
export type InstanceResidentConfig = InstanceConnectConfig & { ownerUserId: string };

export type InstanceCreateInput = {
  tenantId: string;
  ownerUserId: string;
  name: string;
  platform: string;
  accountId: string;
  adapterType: string;
  /**
   * 必填（不是可选）：默认值只允许存在于 service 层一处。
   * 设成可选会让仓储有"漏传就落 DB 默认值"的空间，而 DB 的默认是 `client`，
   * 与产品默认（`server`）相反 —— 这个不一致已经造成过一次真实 bug。
   */
  adapterMode: string;
  endpoint?: string | null;
  accessTokenEnc?: string | null;
  accessTokenDigest?: string | null;
  enabled?: boolean;
  dailyBudgetCents?: number;
  monthlyBudgetCents?: number;
  budgetPolicy?: string;
  credentialId?: string | null;
  modelMain?: string | null;
  modelCheap?: string | null;
  modelFallback?: string | null;
  modelTemperature?: number;
  modelVision?: string | null;
  ttsCredentialId?: string | null;
  ttsModel?: string | null;
  ttsVoice?: string;
  imageHosts?: string;
  proactiveEnabled?: boolean;
  nightQuiet?: string;
};

export type InstanceUpdatePatch = {
  name?: string;
  platform?: string;
  accountId?: string;
  adapterType?: string;
  adapterMode?: string;
  endpoint?: string | null;
  accessTokenEnc?: string | null;
  accessTokenDigest?: string | null;
  enabled?: boolean;
  dailyBudgetCents?: number;
  monthlyBudgetCents?: number;
  budgetPolicy?: string;
  credentialId?: string | null;
  modelMain?: string | null;
  modelCheap?: string | null;
  modelFallback?: string | null;
  modelTemperature?: number;
  modelVision?: string | null;
  ttsCredentialId?: string | null;
  ttsModel?: string | null;
  ttsVoice?: string;
  imageHosts?: string;
  proactiveEnabled?: boolean;
  nightQuiet?: string;
};

export interface IInstanceRepository {
  createForUser(input: InstanceCreateInput): Promise<InstancePublicRow>;
  listForUser(userId: string): Promise<InstancePublicRow[]>;
  findForUser(userId: string, id: string): Promise<InstancePublicRow | null>;
  /** 连接专用：这是唯一会返回密文的读取方法 */
  findForConnect(userId: string, id: string): Promise<InstanceConnectConfig | null>;
  /**
   * 服务启动时的自监听枚举。**这是唯一不带 userId 的读取**，因为它是系统行为：
   * 反向模式下 NapCat 主动连进来，服务重启后必须能自己重新监听，
   * 而那时还没有任何用户会话（DEK 不在内存，token 明文拿不到，只剩摘要）。
   * 只返回 `enabled && mode=server && 有摘要 && 有地址` 的行。
   */
  listResidentListenCandidates(): Promise<InstanceResidentConfig[]>;
  updateForUser(userId: string, id: string, patch: InstanceUpdatePatch): Promise<InstancePublicRow | null>;
  deleteForUser(userId: string, id: string): Promise<boolean>;
  /** 把连接状态落到库里，后台刷新页面时看到的不是内存里的旧值 */
  setStatusForUser(userId: string, id: string, status: string): Promise<boolean>;
  /**
   * 记一条实例事件（M6-1）。**系统行为，不带 userId** —— 它是从适配器事件里来的，
   * 那时没有用户会话；归属由 `instanceId` 决定，而它来自已经鉴权过的连接。
   */
  recordEvent(input: {
    instanceId: string;
    level: string;
    code: string;
    message: string;
    meta?: Record<string, unknown>;
  }): Promise<void>;
  countForUser(userId: string): Promise<number>;
}
