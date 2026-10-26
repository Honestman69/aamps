/**
 * 素材库管理端（M4-3）。
 *
 * 为什么需要它：D034 写了一句"存失败时后台素材列表能立刻看出没存上"，
 * 而那个列表此前**不存在** —— 模型说了"存好了"却没存上时，用户无处可查。
 * 所以这个服务的价值不是"能删图"，是**让素材库可观测**。
 *
 * 三条边界：
 *
 * 1. **只读 + 软删**：不做"改别名"（改名会让旧对话里的 `[use]` 指到别处，D034），
 *    不做硬删（文件可能被多个别名共用，硬删会把别的别名一起打死）。
 * 2. **文件按需读**：列表只给 `fileUrl`，真取字节时再查磁盘；文件丢了要能说清是"文件丢了"
 *    而不是"素材不存在"，否则用户永远查不出是库错了还是盘错了。
 * 3. **删除要留痕**：素材可能是别人的脸/私聊截图，删掉之后至少要能回答"谁在什么时候删的"。
 */

import { AppError } from '@newjob/contracts';

import { AuditAction, AuditService, type AuditActor } from '../auth/audit.service';
import { MAX_ASSETS_PER_INSTANCE } from './assets/asset.service';
import type { IMediaAssetRepository } from './assets/ports';
import type { IMediaFileStore } from './file-store';
import {
  toAssetDTO,
  type AssetListQuery,
  type MediaAssetDTO,
  type MediaAssetListDTO,
} from './dto';

export type MediaActor = {
  sessionId: string;
  userId: string;
  tenantId: string;
  role: string;
  ip?: string | null;
};

export type MediaAdminDeps = {
  repo: IMediaAssetRepository;
  store: IMediaFileStore;
  audit: AuditService;
  clock?: () => Date;
};

function auditActor(role: string): Extract<AuditActor, 'superadmin' | 'user'> {
  return role === 'superadmin' ? 'superadmin' : 'user';
}

/** 跨用户与真不存在返回同一句：不泄漏"这张图存在但不是你的" */
function assetNotFound(): AppError {
  return new AppError('ASSET_NOT_FOUND', '素材不存在', 404);
}

export class MediaAdminService {
  constructor(private readonly deps: MediaAdminDeps) {}

  private now(): Date {
    return this.deps.clock?.() ?? new Date();
  }

  async list(actor: MediaActor, instanceId: string, query: AssetListQuery): Promise<MediaAssetListDTO> {
    const includeDeleted = query.includeDeleted === '1' || query.includeDeleted === 'true';
    const limit = query.limit ?? 60;
    const offset = query.offset ?? 0;

    const [rows, total, stats] = await Promise.all([
      this.deps.repo.listForUser(actor.userId, instanceId, { includeDeleted, limit, offset }),
      this.deps.repo.countForUser(actor.userId, instanceId, { includeDeleted }),
      this.deps.repo.statsForUser(actor.userId, instanceId),
    ]);

    return {
      items: rows.map(toAssetDTO),
      total,
      stats: { ...stats, limit: MAX_ASSETS_PER_INSTANCE },
    };
  }

  /**
   * 软删。已经删过的直接当成功返回（幂等），不再记一条审计 ——
   * 否则双击删除会留下两条"删除"记录，看起来像删了两个东西。
   */
  async remove(
    actor: MediaActor,
    instanceId: string,
    assetId: string,
  ): Promise<{ id: string; alias: string; alreadyDeleted: boolean }> {
    const row = await this.deps.repo.findForUser(actor.userId, instanceId, assetId);
    if (!row) {
      throw assetNotFound();
    }
    if (row.deletedAt !== null) {
      return { id: row.id, alias: row.alias, alreadyDeleted: true };
    }

    const ok = await this.deps.repo.softDeleteForUser(
      actor.userId,
      instanceId,
      assetId,
      this.now(),
    );
    if (!ok) {
      // 并发下被别人先删了：仍然按成功处理，语义同"已经删过"
      return { id: row.id, alias: row.alias, alreadyDeleted: true };
    }

    await this.deps.audit.record({
      tenantId: actor.tenantId,
      actor: auditActor(actor.role),
      actorUserId: actor.userId,
      action: AuditAction.AssetDelete,
      target: row.id,
      targetOwnerId: actor.userId,
      ip: actor.ip ?? null,
      // 只记"删了哪张、多大"，不记图片内容（那本来也不在库里）
      after: { alias: row.alias, bytes: row.bytes },
    });

    return { id: row.id, alias: row.alias, alreadyDeleted: false };
  }

  /**
   * 取文件字节前的解析。
   *
   * 「记录在、文件没了」是真实会发生的（用户手工清 `data/media`、换机器没搬 media 目录），
   * 这时必须报不同的错 —— 否则用户会以为素材库坏了。
   */
  async openFile(
    actor: MediaActor,
    instanceId: string,
    assetId: string,
  ): Promise<{ filePath: string; mime: string; bytes: number; alias: string }> {
    const row = await this.deps.repo.findForUser(actor.userId, instanceId, assetId);
    if (!row || row.deletedAt !== null) {
      throw assetNotFound();
    }
    const filePath = await this.deps.store.find('assets', row.sha256, row.ext);
    if (!filePath) {
      throw new AppError('ASSET_FILE_MISSING', '素材文件已丢失（可能被手工删除或未随媒体目录迁移）', 404);
    }
    return { filePath, mime: row.mime, bytes: row.bytes, alias: row.alias };
  }
}
