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

export const createInstanceSchema = z
  .object({
    name: nameSchema,
    /** 平台标识；默认值在 Service 里补，不放在 zod（`.default()` 会把推断类型变成可选，很难看） */
    platform: z.string().trim().min(1).max(32).optional(),
    /** 平台内账号标识：QQ 为 QQ 号 */
    accountId: accountIdSchema,
    /** 接入方式，对应 registry 的 protocol */
    adapterType: z.string().trim().min(1).max(32).optional(),
    adapterMode: adapterModeSchema.optional(),
    endpoint: endpointSchema.optional(),
    accessToken: accessTokenSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

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
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个要修改的字段' });

export const instanceIdSchema = z.string().trim().min(1).max(64);

export type CreateInstanceInput = z.infer<typeof createInstanceSchema>;
export type UpdateInstanceInput = z.infer<typeof updateInstanceSchema>;

/**
 * 对外 DTO。**没有 `accessTokenEnc`，也没有 `ownerUserId`**。
 * `hasAccessToken` 是布尔，只回答"配没配"，不回答"是什么"。
 */
export type InstancePublicDTO = {
  id: string;
  agentId: string;
  name: string;
  platform: string;
  accountId: string;
  adapterType: string;
  adapterMode: string;
  endpoint: string | null;
  hasAccessToken: boolean;
  enabled: boolean;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export function toInstanceDTO(row: InstancePublicRow): InstancePublicDTO {
  return {
    id: row.id,
    agentId: row.agentId,
    name: row.name,
    platform: row.platform,
    accountId: row.accountId,
    adapterType: row.adapterType,
    adapterMode: row.adapterMode,
    endpoint: row.endpoint,
    hasAccessToken: row.hasAccessToken,
    enabled: row.enabled,
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
