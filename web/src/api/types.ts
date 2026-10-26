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
  /** 接入配置增量（D041）：只放改过的键，没放 = 不改 */
  adapterConfig: AdapterConfigValues;
}>;

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
