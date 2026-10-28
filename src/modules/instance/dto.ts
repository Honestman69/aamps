/**
 * 实例的入参 Schema 与对外 DTO。
 *
 * 关键点：**QQ 号、WS 地址、token 全部是数据，不是配置**
 * （D007 配置面/数据面分离）。一个 QQ 号 = 一条 `BotInstance`，
 * 想换号就在后台新建一条把旧的停掉，代码里没有任何写死的号或地址。
 *
 * 校验刻意不按平台分支（不写 `if (platform === 'qq')`）：
 * 账号格式的差异属于平台知识，应该由适配器 manifest 声明，
 * 而不是在这里长出第二份平台判断。
 */

import type { InstancePublicRow } from './ports';
import { BadRequestError } from '@newjob/contracts';
import { z, type ZodType } from 'zod';

const nameSchema = z.string().trim().min(1).max(64);
const accountIdSchema = z.string().trim().min(1).max(64);
const endpointSchema = z.string().trim().url('必须是合法地址').max(300);
const accessTokenSchema = z.string().trim().min(1).max(512);

/**
 * 连接方向。
 *   `server`（默认）= 对方连本服务：token 由我们在握手阶段校验，云端无需开入站端口
 *   `client`        = 本服务连对方：NapCat 4.18.41 的 WS token 校验有缺陷，等于无鉴权
 */
const adapterModeSchema = z.enum(['client', 'server']);

/** 预算单位是"分"，0 表示不限。上限 1000 万分（10 万元）只是防手滑输入天文数字 */
const budgetCentsSchema = z.number().int().min(0).max(10_000_000);
/** 模型名：允许为空（表示跟随默认），非空时限制长度防脏数据 */
const modelNameSchema = z.string().trim().min(1).max(120);
/** 温度：与 resolver 的合法区间一致，越界直接 400，而不是存进去再被静默夹掉 */
const temperatureSchema = z.number().min(0).max(1.5);
/** 超限策略：降级继续聊，还是直接拒答 */
const budgetPolicySchema = z.enum(['downgrade', 'block']);
/** 音色名：厂商相关，只做长度与空白校验，不猜合法取值 */
const ttsVoiceSchema = z.string().trim().min(1).max(60);
/** 图片域名白名单：逗号分隔，空串 = 不限（仍受私网拦截约束，见 D033） */
const imageHostsSchema = z
  .string()
  .max(500)
  .refine(
    (value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .every((host) => /^[a-z0-9.-]+$/i.test(host)),
    { message: '只填域名（逗号分隔），不要带协议、路径或端口' },
  );

/**
 * 适配器配置（D041）：键来自 `manifest.configFields[].key`，由主服务按 `mapsTo` 翻译成实例列。
 *
 * 这里**只做形状约束**（是个对象、键是字符串、数量有上限），
 * 具体字段与必填条件由适配器清单决定 —— 在 DTO 里写死平台字段名，就等于把
 * "新增平台不改代码"这件事重新做废。
 */
const adapterConfigSchema = z
  .record(z.string().max(64), z.unknown())
  .refine((value) => Object.keys(value).length <= 20, { message: '接入配置项过多' });

/** 两个入口写同一批槽位时必须二选一：同一件事有两个来源，就是"改了没生效"的起点 */
const SLOT_INPUT_KEYS = ['accountId', 'adapterMode', 'endpoint', 'accessToken'] as const;

export const createInstanceSchema = z
  .object({
    name: nameSchema,
    /** 平台标识；默认值在 Service 里补，不放在 zod（`.default()` 会把推断类型变成可选，很难看） */
    platform: z.string().trim().min(1).max(32).optional(),
    /** 平台内账号标识：QQ 为 QQ 号。走 adapterConfig 时由清单里的 selfId 提供，此处可省 */
    accountId: accountIdSchema.optional(),
    /** 接入方式，对应 registry 的 protocol */
    adapterType: z.string().trim().min(1).max(32).optional(),
    adapterMode: adapterModeSchema.optional(),
    endpoint: endpointSchema.optional(),
    accessToken: accessTokenSchema.optional(),
    enabled: z.boolean().optional(),
    dailyBudgetCents: budgetCentsSchema.optional(),
    monthlyBudgetCents: budgetCentsSchema.optional(),
    budgetPolicy: budgetPolicySchema.optional(),
    /** 用哪把 Key（必须属于本人）。换 Provider 就是改这一项 */
    credentialId: z.string().trim().min(1).max(64).nullable().optional(),
    modelMain: modelNameSchema.nullable().optional(),
    modelCheap: modelNameSchema.nullable().optional(),
    modelFallback: modelNameSchema.nullable().optional(),
    modelTemperature: temperatureSchema.optional(),
    /** 多模态（D033）：不填 = 该能力关闭 */
    modelVision: modelNameSchema.nullable().optional(),
    ttsCredentialId: z.string().trim().min(1).max(64).nullable().optional(),
    ttsModel: modelNameSchema.nullable().optional(),
    ttsVoice: ttsVoiceSchema.optional(),
    imageHosts: imageHostsSchema.optional(),
    /** 主动消息（M5-3 / D047）：默认关闭；打开后才会"隔了很久主动说一句" */
    proactiveEnabled: z.boolean().optional(),
    /** 由适配器清单驱动的接入配置（D041）；与下面四个槽位字段互斥 */
    adapterConfig: adapterConfigSchema.optional(),
  })
  .strict()
  .refine((value) => value.accountId !== undefined || value.adapterConfig !== undefined, {
    message: '需要提供 accountId 或 adapterConfig',
  })
  .refine(
    (value) =>
      value.adapterConfig === undefined ||
      SLOT_INPUT_KEYS.every((key) => value[key] === undefined),
    { message: 'adapterConfig 与 accountId / adapterMode / endpoint / accessToken 不能同时提供' },
  );

export const updateInstanceSchema = z
  .object({
    name: nameSchema.optional(),
    platform: z.string().trim().min(1).max(32).optional(),
    accountId: accountIdSchema.optional(),
    adapterType: z.string().trim().min(1).max(32).optional(),
    adapterMode: adapterModeSchema.optional(),
    /** 传 null 表示清空（例如 NapCat 那边没开 token） */
    endpoint: endpointSchema.nullable().optional(),
    accessToken: accessTokenSchema.nullable().optional(),
    enabled: z.boolean().optional(),
    dailyBudgetCents: budgetCentsSchema.optional(),
    monthlyBudgetCents: budgetCentsSchema.optional(),
    budgetPolicy: budgetPolicySchema.optional(),
    credentialId: z.string().trim().min(1).max(64).nullable().optional(),
    modelMain: modelNameSchema.nullable().optional(),
    modelCheap: modelNameSchema.nullable().optional(),
    modelFallback: modelNameSchema.nullable().optional(),
    modelTemperature: temperatureSchema.optional(),
    modelVision: modelNameSchema.nullable().optional(),
    ttsCredentialId: z.string().trim().min(1).max(64).nullable().optional(),
    ttsModel: modelNameSchema.nullable().optional(),
    ttsVoice: ttsVoiceSchema.optional(),
    imageHosts: imageHostsSchema.optional(),
    /** 主动消息（M5-3 / D047）：默认关闭；打开后才会"隔了很久主动说一句" */
    proactiveEnabled: z.boolean().optional(),
    /**
     * 接入配置的**增量**（D041）：只传改过的键。
     * 没传 = 不改；传了空值的必填项仍会被拒（不允许把必填项改空）。
     */
    adapterConfig: adapterConfigSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个要修改的字段' })
  .refine(
    (value) =>
      value.adapterConfig === undefined ||
      SLOT_INPUT_KEYS.every((key) => value[key] === undefined),
    { message: 'adapterConfig 与 accountId / adapterMode / endpoint / accessToken 不能同时提供' },
  );

export const instanceIdSchema = z.string().trim().min(1).max(64);

export type CreateInstanceInput = z.infer<typeof createInstanceSchema>;
export type UpdateInstanceInput = z.infer<typeof updateInstanceSchema>;

/**
 * 对外 DTO。**没有 `accessTokenEnc`，也没有 `ownerUserId`**。
 * `hasAccessToken` 是布尔，只回答"配没配"，不回答"是什么"。
 */
export type InstancePublicDTO = {
  id: string;
  name: string;
  platform: string;
  accountId: string;
  adapterType: string;
  adapterMode: string;
  endpoint: string | null;
  hasAccessToken: boolean;
  enabled: boolean;
  /** 人格预算（D024）：挂在社交账号上，换 Key 不会重置 */
  dailyBudgetCents: number;
  monthlyBudgetCents: number;
  budgetPolicy: string;
  /** 当前绑定的 Key（只有 id；不含任何密钥材料） */
  credentialId: string | null;
  modelMain: string | null;
  modelCheap: string | null;
  modelFallback: string | null;
  modelTemperature: number;
  /** 多模态（D033）：模型/Key 为空表示该能力关闭 */
  modelVision: string | null;
  ttsCredentialId: string | null;
  ttsModel: string | null;
  ttsVoice: string;
  imageHosts: string;
  /** 主动消息开关（M5-3） */
  proactiveEnabled: boolean;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export function toInstanceDTO(row: InstancePublicRow): InstancePublicDTO {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    accountId: row.accountId,
    adapterType: row.adapterType,
    adapterMode: row.adapterMode,
    endpoint: row.endpoint,
    hasAccessToken: row.hasAccessToken,
    enabled: row.enabled,
    dailyBudgetCents: row.dailyBudgetCents,
    monthlyBudgetCents: row.monthlyBudgetCents,
    budgetPolicy: row.budgetPolicy,
    credentialId: row.credentialId,
    modelMain: row.modelMain,
    modelCheap: row.modelCheap,
    modelFallback: row.modelFallback,
    modelTemperature: row.modelTemperature,
    modelVision: row.modelVision,
    ttsCredentialId: row.ttsCredentialId,
    ttsModel: row.ttsModel,
    ttsVoice: row.ttsVoice,
    imageHosts: row.imageHosts,
    proactiveEnabled: row.proactiveEnabled,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function parseOrThrow<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.join('.') ?? '';
    throw new BadRequestError(where ? `${where}: ${issue?.message}` : '参数不合法');
  }
  return result.data;
}
