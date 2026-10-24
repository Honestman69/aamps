/**
 * 凭据模块的入参 Schema 与对外 DTO。
 *
 * 三个刻意的设计：
 *   1. Schema 用 `.strict()`：客户端传 `apiKeyEnc`、`ownerUserId` 这类字段会直接 400，
 *      而不是"悄悄忽略"。静默忽略会让人以为设置生效了。
 *   2. `CredentialPublicDTO` 里**没有** `apiKeyEnc`，也没有 `ownerUserId`。
 *      想加的人先读 `ports.ts` 顶部注释。
 *   3. `maskApiKey` 是纯函数，单独可测：遮码算错等于把 Key 的前缀漏在列表页上。
 */

import { BadRequestError } from '@newjob/contracts';
import { z, type ZodType } from 'zod';

import type { CredentialPublicRow } from './ports';

/** provider 名单以 `prisma/schema.prisma` 的注释为准，这里只校验形态，不锁死枚举（新增 provider 不该改代码） */
const providerSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, '只能包含字母、数字、下划线和短横线');

const labelSchema = z.string().trim().min(1).max(64);
const shortTextSchema = z.string().trim().max(128);

/**
 * API Key 原文。只在 Service 里活一个函数调用栈的时间，随后立刻加密。
 * 不允许含空白：粘错行、带换行是最常见的"Key 无效"来源，宁可在入口拦下。
 */
const apiKeySchema = z
  .string()
  .trim()
  .min(8, 'API Key 长度不足')
  .max(4096)
  .regex(/^\S+$/, '不能包含空白字符');

const authStyleSchema = z.enum(['bearer', 'x-api-key', 'query']);

const baseUrlSchema = z.string().trim().url('必须是合法 URL').max(300);

const budgetSchema = z.number().int().min(0).max(1_000_000_00);

export const createCredentialSchema = z
  .object({
    provider: providerSchema,
    label: labelSchema,
    ownerLabel: shortTextSchema.nullable().optional(),
    baseUrl: baseUrlSchema.nullable().optional(),
    authStyle: authStyleSchema.optional(),
    apiVersion: z.string().trim().max(32).nullable().optional(),
    defaultModel: shortTextSchema.nullable().optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
    dailyBudgetCents: budgetSchema.optional(),
    monthlyBudgetCents: budgetSchema.optional(),
    enabled: z.boolean().optional(),
    /** 明文。加密后只留 `apiKeyEnc` 与 `keyMasked` */
    apiKey: apiKeySchema,
  })
  .strict();

export const updateCredentialSchema = z
  .object({
    provider: providerSchema.optional(),
    label: labelSchema.optional(),
    ownerLabel: shortTextSchema.nullable().optional(),
    baseUrl: baseUrlSchema.nullable().optional(),
    authStyle: authStyleSchema.optional(),
    apiVersion: z.string().trim().max(32).nullable().optional(),
    defaultModel: shortTextSchema.nullable().optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
    dailyBudgetCents: budgetSchema.optional(),
    monthlyBudgetCents: budgetSchema.optional(),
    enabled: z.boolean().optional(),
    /** 提供即视为轮换：重新加密并更新掩码 */
    apiKey: apiKeySchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个要修改的字段' });

export const credentialIdSchema = z.string().trim().min(1).max(64);

export type CreateCredentialInput = z.infer<typeof createCredentialSchema>;
export type UpdateCredentialInput = z.infer<typeof updateCredentialSchema>;

/**
 * 对外 DTO。时间统一 ISO 字符串，字段名保持与前端约定一致。
 * **这里没有 `apiKeyEnc`** —— 编译期就堵死了"列表接口顺手带出密文"的路。
 */
export type CredentialPublicDTO = {
  id: string;
  provider: string;
  label: string;
  ownerLabel: string | null;
  baseUrl: string | null;
  authStyle: string;
  apiVersion: string | null;
  keyMasked: string;
  defaultModel: string | null;
  dailyBudgetCents: number;
  monthlyBudgetCents: number;
  priority: number;
  enabled: boolean;
  disabledBy: string | null;
  lastCheckedAt: string | null;
  lastCheckOk: boolean | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export function toPublicDTO(row: CredentialPublicRow): CredentialPublicDTO {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    ownerLabel: row.ownerLabel,
    baseUrl: row.baseUrl,
    authStyle: row.authStyle,
    apiVersion: row.apiVersion,
    keyMasked: row.keyMasked,
    defaultModel: row.defaultModel,
    dailyBudgetCents: row.dailyBudgetCents,
    monthlyBudgetCents: row.monthlyBudgetCents,
    priority: row.priority,
    enabled: row.enabled,
    disabledBy: row.disabledBy,
    lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
    lastCheckOk: row.lastCheckOk,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 生成展示用掩码：`sk-****a1b2`。
 *
 * 规则：保留可识别的前缀（`sk-` 这类）与末 4 位，中间固定 4 个星号。
 * 短于 12 位的一律全遮 —— 否则"遮完"等于"直接告诉你"。
 * 用固定 4 星而不是按长度生成，是为了不泄漏原始 Key 的长度。
 */
export function maskApiKey(apiKey: string): string {
  const key = apiKey.trim();
  if (key.length < 12) {
    return '****';
  }
  const prefix = key.slice(0, 3);
  return `${prefix}****${key.slice(-4)}`;
}

/** 与 auth 模块同名的工具，行为保持一致（错误转换为 400 + 字段路径） */
export function parseOrThrow<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.join('.') ?? '';
    throw new BadRequestError(where ? `${where}: ${issue?.message}` : '参数不合法');
  }
  return result.data;
}
