/**
 * 素材库的 Prisma 实现。
 *
 * 所有查询都带 `instanceId`，`deletedAt: null` 是**默认条件**而不是可选项：
 * 软删的素材不能再被发送，但名字要继续占位。
 */

import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';

import type {
  CreateAssetInput,
  CreateAssetResult,
  IMediaAssetRepository,
  MediaAssetRecord,
} from '../ports';

const SELECT = {
  id: true,
  instanceId: true,
  alias: true,
  kind: true,
  sha256: true,
  ext: true,
  mime: true,
  bytes: true,
  tags: true,
  useCount: true,
  lastUsedAt: true,
  createdAt: true,
} as const;

export class PrismaMediaAssetRepository implements IMediaAssetRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listUsable(instanceId: string, limit: number): Promise<MediaAssetRecord[]> {
    return this.prisma.mediaAsset.findMany({
      where: { instanceId, deletedAt: null },
      select: SELECT,
      // 常用的、最近用过的排前面：模型看到的清单要像"手边那几张"
      orderBy: [{ useCount: 'desc' }, { lastUsedAt: 'desc' }, { createdAt: 'desc' }],
      take: Math.max(1, limit),
    });
  }

  async findByAlias(instanceId: string, alias: string): Promise<MediaAssetRecord | null> {
    return this.prisma.mediaAsset.findFirst({
      where: { instanceId, alias, deletedAt: null },
      select: SELECT,
    });
  }

  async findBySha(instanceId: string, sha256: string): Promise<MediaAssetRecord | null> {
    return this.prisma.mediaAsset.findFirst({
      where: { instanceId, sha256, deletedAt: null },
      select: SELECT,
    });
  }

  async countUsable(instanceId: string): Promise<number> {
    return this.prisma.mediaAsset.count({ where: { instanceId, deletedAt: null } });
  }

  async create(input: CreateAssetInput): Promise<CreateAssetResult> {
    try {
      const asset = await this.prisma.mediaAsset.create({
        data: {
          instanceId: input.instanceId,
          alias: input.alias,
          ...(input.kind ? { kind: input.kind } : {}),
          sha256: input.sha256,
          ext: input.ext,
          mime: input.mime,
          bytes: input.bytes,
          ...(input.source ? { source: input.source } : {}),
          ...(input.tags ? { tags: input.tags } : {}),
        },
        select: SELECT,
      });
      return { ok: true, asset };
    } catch (err) {
      // 唯一键冲突 = 别名已被占用（含已软删的：名字不回收，见 schema 注释）
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return { ok: false, reason: 'alias_taken' };
      }
      throw err;
    }
  }

  async markUsed(instanceId: string, assetId: string, now: Date): Promise<void> {
    await this.prisma.mediaAsset.updateMany({
      // 归属过滤不能省：拿到别的实例的 id 也只更新 0 行
      where: { id: assetId, instanceId, deletedAt: null },
      data: { useCount: { increment: 1 }, lastUsedAt: now },
    });
  }

  async softDelete(instanceId: string, alias: string, now: Date): Promise<boolean> {
    const { count } = await this.prisma.mediaAsset.updateMany({
      where: { instanceId, alias, deletedAt: null },
      data: { deletedAt: now },
    });
    return count > 0;
  }
}
