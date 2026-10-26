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
  configFields: Array<{
    key: string;
    label: string;
    type: string;
    required?: boolean;
    placeholder?: string;
    help?: string;
    secret?: boolean;
  }>;
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
}>;
