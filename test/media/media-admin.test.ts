/**
 * 素材库管理端测试（M4-3）。
 *
 * 重点不是"列表能返回"，而是四件容易做错的事：
 *   1. 归属 —— 拿别人的 instanceId / assetId 只能得到空结果或 404；
 *   2. 软删 —— 删了之后 `deleted: true`，但记录还在（名字占位）；
 *   3. 文件丢了 —— 报的是「文件丢失」不是「素材不存在」，否则用户查不出是盘的问题；
 *   4. 审计 —— 删除留痕，重复删不重复记。
 */

import { describe, expect, it } from 'vitest';

import { AppError } from '@newjob/contracts';

import { AuditAction } from '@/modules/auth/audit.service';
import type {
  IMediaAssetRepository,
  MediaAssetAdminRecord,
  MediaAssetListOptions,
  MediaAssetStats,
} from '@/modules/media/assets/ports';
import type { IMediaFileStore } from '@/modules/media/file-store';
import { MediaAdminService, type MediaActor } from '@/modules/media/media-admin.service';

const ACTOR: MediaActor = {
  sessionId: 's1',
  userId: 'u1',
  tenantId: 't1',
  role: 'user',
  ip: null,
};

const NOW = new Date('2026-10-26T10:00:00');

function asset(overrides: Partial<MediaAssetAdminRecord> = {}): MediaAssetAdminRecord {
  return {
    id: 'a1',
    instanceId: 'i1',
    alias: '猫猫震惊',
    kind: 'image',
    sha256: 'a'.repeat(64),
    ext: 'png',
    mime: 'image/png',
    bytes: 2048,
    tags: '',
    useCount: 3,
    lastUsedAt: new Date('2026-10-25T09:00:00'),
    createdAt: new Date('2026-10-20T09:00:00'),
    source: 'inbound',
    deletedAt: null,
    ...overrides,
  };
}

class FakeRepo implements IMediaAssetRepository {
  rows: MediaAssetAdminRecord[] = [asset()];
  deleted: Array<{ assetId: string; now: Date }> = [];
  lastOptions: MediaAssetListOptions | null = null;

  private owned(userId: string, row: MediaAssetAdminRecord): boolean {
    return userId === 'u1' && row.instanceId === 'i1';
  }

  async listForUser(
    userId: string,
    instanceId: string,
    options: MediaAssetListOptions,
  ): Promise<MediaAssetAdminRecord[]> {
    this.lastOptions = options;
    return this.rows
      .filter((row) => row.instanceId === instanceId && this.owned(userId, row))
      .filter((row) => (options.includeDeleted ? true : row.deletedAt === null))
      .slice(options.offset, options.offset + options.limit);
  }

  async countForUser(userId: string, instanceId: string, options: { includeDeleted: boolean }) {
    return this.rows
      .filter((row) => row.instanceId === instanceId && this.owned(userId, row))
      .filter((row) => (options.includeDeleted ? true : row.deletedAt === null)).length;
  }

  async statsForUser(userId: string, instanceId: string): Promise<MediaAssetStats> {
    const own = this.rows.filter((row) => row.instanceId === instanceId && this.owned(userId, row));
    const usable = own.filter((row) => row.deletedAt === null);
    return {
      usable: usable.length,
      deleted: own.length - usable.length,
      bytes: usable.reduce((sum, row) => sum + row.bytes, 0),
    };
  }

  async findForUser(userId: string, instanceId: string, assetId: string) {
    const row = this.rows.find(
      (item) => item.id === assetId && item.instanceId === instanceId && this.owned(userId, item),
    );
    return row ?? null;
  }

  async softDeleteForUser(userId: string, instanceId: string, assetId: string, now: Date) {
    const row = await this.findForUser(userId, instanceId, assetId);
    if (!row || row.deletedAt !== null) {
      return false;
    }
    row.deletedAt = now;
    this.deleted.push({ assetId, now });
    return true;
  }

  // 管道侧方法，本测试用不到
  async listUsable() {
    return [];
  }
  async findByAlias() {
    return null;
  }
  async findBySha() {
    return null;
  }
  async countUsable() {
    return 0;
  }
  async create() {
    return { ok: false as const, reason: 'alias_taken' as const };
  }
  async markUsed() {
    /* noop */
  }
  async softDelete() {
    return false;
  }
}

class FakeStore implements IMediaFileStore {
  existing = new Map<string, string>();

  async find(kind: string, key: string, ext: string): Promise<string | null> {
    return this.existing.get(`${kind}/${key}.${ext}`) ?? null;
  }
  async write(): Promise<string> {
    return '/dev/null';
  }
}

class FakeAudit {
  records: Array<Record<string, unknown>> = [];
  async record(input: Record<string, unknown>): Promise<unknown> {
    this.records.push(input);
    return input;
  }
}

function makeService() {
  const repo = new FakeRepo();
  const store = new FakeStore();
  const audit = new FakeAudit();
  const service = new MediaAdminService({
    repo,
    store,
    audit: audit as never,
    clock: () => NOW,
  });
  return { repo, store, audit, service };
}

describe('MediaAdminService 列表', () => {
  it('默认不含已删，出参带 fileUrl 与 ISO 时间', async () => {
    const { service, repo } = makeService();
    repo.rows = [asset(), asset({ id: 'a2', alias: '旧的', deletedAt: NOW })];

    const result = await service.list(ACTOR, 'i1', {});

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.alias).toBe('猫猫震惊');
    expect(result.items[0]?.fileUrl).toBe('/api/instances/i1/assets/a1/file');
    expect(result.items[0]?.deleted).toBe(false);
    expect(result.items[0]?.lastUsedAt).toBe(new Date('2026-10-25T09:00:00').toISOString());
    expect(result.stats).toEqual({ usable: 1, deleted: 1, bytes: 2048, limit: 200 });
  });

  it('includeDeleted=1 时把软删的也列出来，deleted=true', async () => {
    const { service, repo } = makeService();
    repo.rows = [asset(), asset({ id: 'a2', alias: '旧的', deletedAt: NOW })];

    const result = await service.list(ACTOR, 'i1', { includeDeleted: '1' });

    expect(result.items.map((item) => item.deleted)).toEqual([false, true]);
    expect(result.total).toBe(2);
  });

  it('分页参数透传到仓储（limit/offset），非法值被兜底', async () => {
    const { service, repo } = makeService();

    await service.list(ACTOR, 'i1', { limit: 10, offset: 20 });
    expect(repo.lastOptions).toEqual({ includeDeleted: false, limit: 10, offset: 20 });

    await service.list(ACTOR, 'i1', {});
    expect(repo.lastOptions?.limit).toBe(60);
    expect(repo.lastOptions?.offset).toBe(0);
  });

  it('别人的实例：只能拿到空列表（不报错、不泄漏存在性）', async () => {
    const { service } = makeService();
    const result = await service.list({ ...ACTOR, userId: 'u2' }, 'i1', {});
    expect(result.items).toEqual([]);
    expect(result.stats.usable).toBe(0);
  });
});

describe('MediaAdminService 删除', () => {
  it('软删：记录留着、名字仍占位，并留一条审计', async () => {
    const { service, repo, audit } = makeService();

    const result = await service.remove(ACTOR, 'i1', 'a1');

    expect(result).toEqual({ id: 'a1', alias: '猫猫震惊', alreadyDeleted: false });
    expect(repo.deleted).toEqual([{ assetId: 'a1', now: NOW }]);
    expect(repo.rows[0]?.deletedAt).toEqual(NOW);
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]?.action).toBe(AuditAction.AssetDelete);
    // 只记摘要，不记内容
    expect(audit.records[0]?.after).toEqual({ alias: '猫猫震惊', bytes: 2048 });
  });

  it('重复删：幂等且不重复记审计', async () => {
    const { service, repo, audit } = makeService();
    repo.rows = [asset({ deletedAt: NOW })];

    const result = await service.remove(ACTOR, 'i1', 'a1');

    expect(result.alreadyDeleted).toBe(true);
    expect(audit.records).toHaveLength(0);
  });

  it('不存在 / 别人的素材 → 404（同一句话）', async () => {
    const { service } = makeService();

    await expect(service.remove(ACTOR, 'i1', 'nope')).rejects.toMatchObject({
      code: 'ASSET_NOT_FOUND',
      httpStatus: 404,
    });
    await expect(service.remove({ ...ACTOR, userId: 'u2' }, 'i1', 'a1')).rejects.toMatchObject({
      code: 'ASSET_NOT_FOUND',
    });
  });
});

describe('MediaAdminService 取文件', () => {
  it('命中：返回本地路径与 mime', async () => {
    const { service, store } = makeService();
    store.existing.set(`assets/${'a'.repeat(64)}.png`, 'C:/media/assets/x.png');

    const file = await service.openFile(ACTOR, 'i1', 'a1');

    expect(file).toEqual({
      filePath: 'C:/media/assets/x.png',
      mime: 'image/png',
      bytes: 2048,
      alias: '猫猫震惊',
    });
  });

  it('记录在但文件丢了 → ASSET_FILE_MISSING（不是"素材不存在"）', async () => {
    const { service } = makeService();

    await expect(service.openFile(ACTOR, 'i1', 'a1')).rejects.toMatchObject({
      code: 'ASSET_FILE_MISSING',
    });
  });

  it('已软删的不能取 → 404', async () => {
    const { service, repo, store } = makeService();
    repo.rows = [asset({ deletedAt: NOW })];
    store.existing.set(`assets/${'a'.repeat(64)}.png`, 'C:/media/assets/x.png');

    await expect(service.openFile(ACTOR, 'i1', 'a1')).rejects.toBeInstanceOf(AppError);
  });
});
