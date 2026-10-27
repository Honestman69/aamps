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

/**
 * 管理端要看的字段：比管道侧多 `source`（怎么来的）与 `deletedAt`（是否已软删）。
 * 这两个字段**不进 prompt、也不参与发送**，所以不塞进 `MediaAssetRecord`。
 */
export type MediaAssetAdminRecord = MediaAssetRecord & {
  source: string;
  deletedAt: Date | null;
};

export type MediaAssetListOptions = {
  /** 后台要能看见已删的（名字仍占位，用户需要知道"为什么这个名字不能用"） */
  includeDeleted: boolean;
  limit: number;
  offset: number;
};

export type MediaAssetStats = {
  usable: number;
  deleted: number;
  /** 可用素材的总字节数（软删的不算：它们只是记录，文件可能还被别的别名共用） */
  bytes: number;
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

  // ── 管理端（带 owner，供后台列表 / 删除 / 取文件用） ──
  //
  // 这几个方法**不接收裸 instanceId**，而是 `(userId, instanceId)`：
  // 归属过滤写成 `instance: { ownerUserId }`，拿别人的 id 只会得到空结果，
  // 而不是"查到之后再判断"（AGENTS 硬性规则 5）。

  listForUser(
    userId: string,
    instanceId: string,
    options: MediaAssetListOptions,
  ): Promise<MediaAssetAdminRecord[]>;

  countForUser(
    userId: string,
    instanceId: string,
    options: Pick<MediaAssetListOptions, 'includeDeleted'>,
  ): Promise<number>;

  statsForUser(userId: string, instanceId: string): Promise<MediaAssetStats>;

  findForUser(
    userId: string,
    instanceId: string,
    assetId: string,
  ): Promise<MediaAssetAdminRecord | null>;

  /** 按 id 软删；返回 false = 不存在 / 不属于这个用户 */
  softDeleteForUser(
    userId: string,
    instanceId: string,
    assetId: string,
    now: Date,
  ): Promise<boolean>;
}
