/**
 * 前端用的接口类型。
 *
 * 手抄自服务端 DTO（`src/modules/<模块>/dto.ts`），不是自动生成。
 * 为什么不共享类型：`web` 的 tsconfig 是 Bundler/DOM，主服务是 commonjs，两套编译目标不一样；
 * 强行共享会逼着主服务把 zod 一起打进前端包。抄一份、字段少而准，比引一层构建耦合划算。
 *
 * 约定：**所有时间为 ISO 字符串，所有金额单位为分。**
 */

export type MeResponse = {
  user: { id: string; role: string; username: string | null };
  unlocked: boolean;
  unlockExpiresAt: string | null;
};

export type LoginResponse = {
  user: { id: string; username: string; role: string };
  unlocked: boolean;
  unlockExpiresAt: string;
};

export type Credential = {
  id: string;
  provider: string;
  label: string;
  ownerLabel: string | null;
  baseUrl: string | null;
  authStyle: string;
  apiVersion: string | null;
  keyMasked: string;
  defaultModel: string | null;
  priority: number;
  enabled: boolean;
  disabledBy: string | null;
  lastCheckedAt: string | null;
  lastCheckOk: boolean | null;
  lastError: string | null;
  balance: {
    cents: number | null;
    currency: string | null;
    checkedAt: string | null;
    source: string | null;
  };
  health: { available: boolean; reason: string | null; cooldownUntil: string | null };
  createdAt: string;
  updatedAt: string;
};

export type Instance = {
  id: string;
  name: string;
  platform: string;
  accountId: string;
  adapterType: string;
  adapterMode: string;
  endpoint: string | null;
  hasAccessToken: boolean;
  enabled: boolean;
  dailyBudgetCents: number;
  monthlyBudgetCents: number;
  budgetPolicy: string;
  credentialId: string | null;
  modelMain: string | null;
  modelCheap: string | null;
  modelFallback: string | null;
  modelTemperature: number;
  /** 多模态（D033）：为空 = 该能力关闭 */
  modelVision: string | null;
  ttsCredentialId: string | null;
  ttsModel: string | null;
  ttsVoice: string;
  imageHosts: string;
  /** 主动消息开关（M5-3）：默认关闭 */
  proactiveEnabled: boolean;
  /** 夜间静默时段（M6-2）：`HH:MM-HH:MM` 或 `off`；只作用于群聊 */
  nightQuiet: string;
  /** 健康分（M6-1）：0-100，由风控巡检写入，只读 */
  healthScore: number;
  status: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * 配置字段（对应 contracts 的 `ConfigField`，D041）。
 *
 * `mapsTo` 是**主服务用的**：它说明这个值最终写进实例的哪个槽位。
 * 前端不需要（也不该）拿它拼请求体 —— 提交时原样回传 `adapterConfig: { key: 值 }` 就行，
 * 翻译由后端按同一张清单完成。
 */
export type AdapterConfigField = {
  key: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'switch' | 'select' | 'textarea';
  required?: boolean;
  /** 条件必填：`requiredWhen.field` 的值落在 `in` 里时才算必填 */
  requiredWhen?: { field: string; in: Array<string | number | boolean> };
  placeholder?: string;
  help?: string;
  default?: string | number | boolean;
  options?: Array<{ label: string; value: string }>;
  secret?: boolean;
  mapsTo?: 'accountId' | 'adapterMode' | 'endpoint' | 'accessToken';
};

export type AdapterManifest = {
  platform: string;
  protocol: string;
  displayName: string;
  description?: string;
  version: string;
  capabilities: {
    sessionKinds: string[];
    canSendProactive: boolean;
    maxTextLength: number;
    publicReply: boolean;
    requiresMentionInPublic: boolean;
    media: { image: boolean; voice: boolean; video: boolean; file: boolean; quote: boolean; recall: boolean };
  };
  configFields: AdapterConfigField[];
};

export type PersonaStatus = 'draft' | 'published' | 'archived';

export type Persona = {
  id: string;
  instanceId: string;
  name: string;
  avatar: string | null;
  tagline: string | null;
  identity: Record<string, string>;
  promptBlocks: Array<{ key?: string; title?: string; content: string; enabled?: boolean; order?: number }>;
  examples: Array<{ user?: string; assistant?: string }>;
  opening: Record<string, string>;
  boundaries: string[];
  variables: Record<string, string>;
  behavior: {
    attention?: Partial<{
      base: number;
      privateBoost: number;
      thresholdPrivate: number;
      thresholdGroup: number;
      thresholdBusy: number;
      weights: Partial<Record<'mention' | 'topicMatch' | 'followUp' | 'groupVibe' | 'affinity' | 'lowEnergy', number>>;
    }>;
    expression?: Partial<{
      maxCharsPerSegment: number;
      maxSegments: number;
      splitChance: number;
      readBaseMs: number;
      readPerCharMs: number;
      readJitter: number;
      typingCps: number;
      busyFactor: number;
      nightFactor: number;
      mediaDelayMs: number;
      maxTotalMs: number;
      mentionBack: boolean;
    }>;
    think?: { enabled?: boolean };
  };
  fallbacks: {
    shortOutage?: { private?: string | null; group?: string | null };
    longOutage?: { private?: string | null; group?: string | null };
    budgetLimit?: { private?: string | null; group?: string | null };
  };
  quoteTendency: string;
  version: number;
  status: PersonaStatus;
  publishedAt: string | null;
  archivedAt: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

/** 人设可写字段：服务端全部 `.strict()`，拼错字段名直接 400 */
export type PersonaPatch = Partial<
  Pick<
    Persona,
    | 'name'
    | 'avatar'
    | 'tagline'
    | 'identity'
    | 'promptBlocks'
    | 'examples'
    | 'opening'
    | 'boundaries'
    | 'variables'
    | 'behavior'
    | 'fallbacks'
    | 'quoteTendency'
  >
>;

/** 素材库（D034 / M4-3）：给人看的视图，模型看不到这些字段 */
export type MediaAsset = {
  id: string;
  alias: string;
  kind: string;
  mime: string;
  bytes: number;
  tags: string;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  source: string;
  /** 已软删：名字仍占位，所以界面上要能看到它并解释"为什么这个名字不能用" */
  deleted: boolean;
  /** 同源缩略图地址（需要会话 cookie） */
  fileUrl: string;
};

export type MediaAssetList = {
  items: MediaAsset[];
  total: number;
  stats: { usable: number; deleted: number; bytes: number; limit: number };
};

export type AdapterConfigValues = Record<string, string | number | boolean>;

export type InstancePatch = Partial<{
  name: string;
  platform: string;
  accountId: string;
  adapterType: string;
  adapterMode: string;
  endpoint: string | null;
  accessToken: string | null;
  enabled: boolean;
  dailyBudgetCents: number;
  monthlyBudgetCents: number;
  budgetPolicy: string;
  credentialId: string | null;
  modelMain: string | null;
  modelCheap: string | null;
  modelFallback: string | null;
  modelTemperature: number;
  modelVision: string | null;
  ttsCredentialId: string | null;
  ttsModel: string | null;
  ttsVoice: string;
  imageHosts: string;
  /** 主动消息开关（M5-3） */
  proactiveEnabled: boolean;
  /** 夜间静默（M6-2）：`HH:MM-HH:MM` 或 `off` */
  nightQuiet: string;
  /** 接入配置增量（D041）：只放改过的键，没放 = 不改 */
  adapterConfig: AdapterConfigValues;
}>;

/** 实例健康（M6-1 / D048）：分数给人看，动作由机器执行 */
export type RiskOverview = {
  instanceId: string;
  score: number;
  level: 'healthy' | 'degraded' | 'readonly' | 'stopped';
  reasons: string[];
  consecutiveBlocks: number;
  action: { kind: string; until?: string; reason?: string };
  silentUntil: string | null;
};

/** 实例事件（M6-3）：登录态、拦截、降级都记在这里 */
export type InstanceEvent = {
  id: string;
  level: string;
  code: string;
  message: string;
  meta: unknown;
  createdAt: string;
};

/** 管理端用户视图（D042）：只有身份与状态，没有任何密钥材料 */
export type AdminUser = {
  id: string;
  username: string;
  displayName: string | null;
  role: 'superadmin' | 'user' | string;
  status: 'active' | 'disabled' | string;
  /** DEK 是否已初始化：false = 从没登录过（或密码被重置过） */
  dekInitialized: boolean;
  dekVersion: number;
  lastLoginAt: string | null;
  createdAt: string;
  /** 是不是当前登录者自己（后端给的，避免前端拿 id 比来比去） */
  isSelf?: boolean;
};

/**
 * 审计记录（D044）。
 *
 * `before` / `after` 是**已经脱敏过的业务字段**（服务端按字段名精确裁剪），
 * 不含密码、密文、完整 QQ 号。前端不要指望它们一定有内容：
 * `credential.unlock` 这类事件本来就没有字段变化，两边都是 null。
 */
export type AuditEntry = {
  id: string;
  /** 操作者类型：superadmin / user / system / worker */
  actor: string;
  actorUserId: string | null;
  /** 形如 `credential.rotate`，前缀即模块 */
  action: string;
  /** 被操作对象的可读标识（用户名、Key 标签、人设名……），可能为 null */
  target: string | null;
  targetOwnerId: string | null;
  ip: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  prevHash: string | null;
  hash: string;
  createdAt: string;
};

/** 哈希链校验结果：失败时带断点，前端据此定位那一行 */
export type AuditChainVerifyResult =
  | { ok: true; checked: number }
  | { ok: false; checked: number; brokenAtId: string; index: number; reason: string };

export type UserMutationResult = {
  id: string;
  username: string;
  role: string;
  status: string;
  /** 改角色/停用时被踢下线的会话数 */
  revokedSessions: number;
};

export type CreateUserInput = {
  username: string;
  displayName?: string | null;
  password: string;
  role?: 'user' | 'superadmin';
};

export type UpdateUserInput = Partial<{
  displayName: string | null;
  role: 'user' | 'superadmin';
  status: 'active' | 'disabled';
}>;

/** 会话摘要（D043）。`messageCount` 是服务端实时算的，不是 Session 表那列 */
export type SessionSummary = {
  id: string;
  kind: 'private' | 'group';
  peerId: string;
  peerName: string | null;
  lastActiveAt: string;
  messageCount: number;
  /** 人工接管：AI 不回，消息照收 */
  aiPaused: boolean;
  reviewMode: boolean;
  muted: boolean;
  lastMessage: {
    role: string;
    content: string;
    senderName: string | null;
    createdAt: string;
  } | null;
};

/** 内心独白（D036）：看记录时能知道"它当时怎么想的" */
export type MessageThink = {
  wantToReply: number;
  emotionShift: number;
  intent: string;
  keyPoints: string[];
  tone: string;
  lengthHint: string;
};

export type SessionMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  senderName: string | null;
  content: string;
  createdAt: string;
  /** 这条消息里出现过哪些媒体类型（image / voice / at / reply）；**不含 URL** */
  media: string[];
  think: MessageThink | null;
  blocked: boolean;
  blockReason: string | null;
};

export type MessagePage = {
  items: SessionMessage[];
  hasMore: boolean;
};
