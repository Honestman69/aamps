/**
 * 素材库端口（D034）。
 *
 * 与凭据一样，**每个方法都带 `instanceId`**：素材是这个社交账号的，不是这个用户的。
 * 没有 `findById`，也没有"列出全部"——素材只在两个地方被读：
 * 拼 prompt 时的清单摘要、发送时按别名解析。
 */

export type MediaAssetRecord = {
  id: string;
  instanceId: string;
  alias: string;
  kind: string;
  /** 内容 hash：文件路径由 `assets/<sha256>.<ext>` 推出，库里不存绝对路径 */
  sha256: string;
  ext: string;
  mime: string;
  bytes: number;
  tags: string;
  useCount: number;
  lastUsedAt: Date | null;
  createdAt: Date;
};

export type CreateAssetInput = {
  instanceId: string;
  alias: string;
  kind?: string;
  sha256: string;
  ext: string;
  mime: string;
  bytes: number;
  source?: string;
  tags?: string;
};

/** 别名撞车不是异常，是一个必须被上层展示的结果（"换个名字"） */
export type CreateAssetResult =
  | { ok: true; asset: MediaAssetRecord }
  | { ok: false; reason: 'alias_taken' };

export interface IMediaAssetRepository {
  /** 可用于 prompt 的清单：按使用频次与最近使用排序 */
  listUsable(instanceId: string, limit: number): Promise<MediaAssetRecord[]>;

  /** 软删的记录不算（名字仍占位，见 schema 注释） */
  findByAlias(instanceId: string, alias: string): Promise<MediaAssetRecord | null>;

  /** 内容去重：同一张图只存一份文件，但可以有多个别名 */
  findBySha(instanceId: string, sha256: string): Promise<MediaAssetRecord | null>;

  countUsable(instanceId: string): Promise<number>;

  create(input: CreateAssetInput): Promise<CreateAssetResult>;

  markUsed(instanceId: string, assetId: string, now: Date): Promise<void>;

  softDelete(instanceId: string, alias: string, now: Date): Promise<boolean>;
}
