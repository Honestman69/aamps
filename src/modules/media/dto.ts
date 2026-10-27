/**
 * 素材库管理接口的入参与出参。
 *
 * 与管道侧的差别：这里**给人看**，所以会出现 `bytes` / `useCount` / `deleted` 这些
 * 模型永远看不到的字段；同样也**绝不出现** `sha256` 与文件路径 ——
 * 前端只要一个 `fileUrl`，路径拼在服务端做（前端拼路径等于把目录结构写进浏览器）。
 */

import { BadRequestError } from '@newjob/contracts';
import { z, type ZodType } from 'zod';

import type { MediaAssetAdminRecord } from './assets/ports';

export const instanceIdSchema = z.string().trim().min(1).max(64);
export const assetIdSchema = z.string().trim().min(1).max(64);

/** 一页最多 100：素材上限本身是 200，两屏能看完 */
export const ASSET_MAX_PAGE = 100;

export const assetListQuerySchema = z
  .object({
    includeDeleted: z.enum(['0', '1', 'true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(ASSET_MAX_PAGE).optional(),
    offset: z.coerce.number().int().min(0).max(100_000).optional(),
  })
  .strict();

export type AssetListQuery = z.infer<typeof assetListQuerySchema>;

export type MediaAssetDTO = {
  id: string;
  alias: string;
  kind: string;
  mime: string;
  bytes: number;
  tags: string;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  /** inbound = 对话里存的；upload = 后台上传（M5 才有） */
  source: string;
  /** 已软删：名字仍占位，所以前端要能看见它并解释"这个名字为什么不能用" */
  deleted: boolean;
  /** 缩略图地址（同源、需要会话 cookie） */
  fileUrl: string;
};

export type MediaAssetListDTO = {
  items: MediaAssetDTO[];
  /** 与当前过滤条件一致的总数（分页用） */
  total: number;
  stats: {
    usable: number;
    deleted: number;
    bytes: number;
    /** 每实例上限，前端据此显示 "12 / 200" */
    limit: number;
  };
};

export function assetFileUrl(instanceId: string, assetId: string): string {
  return `/api/instances/${encodeURIComponent(instanceId)}/assets/${encodeURIComponent(assetId)}/file`;
}

export function toAssetDTO(row: MediaAssetAdminRecord): MediaAssetDTO {
  return {
    id: row.id,
    alias: row.alias,
    kind: row.kind,
    mime: row.mime,
    bytes: row.bytes,
    tags: row.tags,
    useCount: row.useCount,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    source: row.source,
    deleted: row.deletedAt !== null,
    fileUrl: assetFileUrl(row.instanceId, row.id),
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
