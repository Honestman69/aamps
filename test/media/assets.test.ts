import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { MediaAssetService } from '@/modules/media/assets/asset.service';
import type {
  CreateAssetInput,
  CreateAssetResult,
  IMediaAssetRepository,
  MediaAssetAdminRecord,
  MediaAssetListOptions,
  MediaAssetRecord,
  MediaAssetStats,
} from '@/modules/media/assets/ports';
import type { FetchedImage, IImageFetcher } from '@/modules/media/fetcher';
import type { IMediaFileStore } from '@/modules/media/file-store';

const PNG = Buffer.from('fake-png-bytes');

class FakeRepo implements IMediaAssetRepository {
  rows: MediaAssetRecord[] = [];
  used: string[] = [];
  private seq = 0;

  async listUsable(_instanceId: string, limit: number): Promise<MediaAssetRecord[]> {
    return this.rows.slice(0, limit);
  }
  async findByAlias(instanceId: string, alias: string): Promise<MediaAssetRecord | null> {
    return this.rows.find((r) => r.instanceId === instanceId && r.alias === alias) ?? null;
  }
  async findBySha(instanceId: string, sha256: string): Promise<MediaAssetRecord | null> {
    return this.rows.find((r) => r.instanceId === instanceId && r.sha256 === sha256) ?? null;
  }
  async countUsable(): Promise<number> {
    return this.rows.length;
  }
  async create(input: CreateAssetInput): Promise<CreateAssetResult> {
    if (this.rows.some((r) => r.instanceId === input.instanceId && r.alias === input.alias)) {
      return { ok: false, reason: 'alias_taken' };
    }
    this.seq += 1;
    const asset: MediaAssetRecord = {
      id: `asset-${this.seq}`,
      instanceId: input.instanceId,
      alias: input.alias,
      kind: input.kind ?? 'image',
      sha256: input.sha256,
      ext: input.ext,
      mime: input.mime,
      bytes: input.bytes,
      tags: input.tags ?? '',
      useCount: 0,
      lastUsedAt: null,
      createdAt: new Date('2026-10-25T10:00:00'),
    };
    this.rows.push(asset);
    return { ok: true, asset };
  }
  async markUsed(_instanceId: string, assetId: string): Promise<void> {
    this.used.push(assetId);
  }
  // 管理端方法在另一个测试文件里用专门的假实现；这里只需要满足接口
  async listForUser(): Promise<MediaAssetAdminRecord[]> {
    return [];
  }
  async countForUser(): Promise<number> {
    return 0;
  }
  async statsForUser(): Promise<MediaAssetStats> {
    return { usable: 0, deleted: 0, bytes: 0 };
  }
  async findForUser(): Promise<MediaAssetAdminRecord | null> {
    return null;
  }
  async softDeleteForUser(_userId: string, _instanceId: string, _assetId: string, now: Date): Promise<boolean> {
    void now;
    return false;
  }

  async softDelete(instanceId: string, alias: string): Promise<boolean> {
    const row = this.rows.find((r) => r.instanceId === instanceId && r.alias === alias);
    if (!row) return false;
    this.rows = this.rows.filter((r) => r !== row);
    return true;
  }
}

class FakeStore implements IMediaFileStore {
  files = new Map<string, Buffer>();
  async find(kind: string, key: string, ext: string): Promise<string | null> {
    return this.files.has(`${kind}/${key}.${ext}`) ? `/media/${kind}/${key}.${ext}` : null;
  }
  async write(kind: string, key: string, ext: string, data: Buffer): Promise<string> {
    this.files.set(`${kind}/${key}.${ext}`, data);
    return `/media/${kind}/${key}.${ext}`;
  }
}

class FakeImages implements IImageFetcher {
  result: FetchedImage | null = { data: PNG, mime: 'image/png' };
  calls: string[] = [];
  async fetch(url: string): Promise<FetchedImage | null> {
    this.calls.push(url);
    // 模拟真实的私网拦截：内网地址抓不到
    if (/^https?:\/\/(127\.|10\.|192\.168\.|localhost)/.test(url)) {
      return null;
    }
    return this.result;
  }
  async fetchAsDataUrl(): Promise<{ dataUrl: string; bytes: number } | null> {
    return null;
  }
}

function makeService(overrides: { maxBytes?: number; maxPerInstance?: number } = {}) {
  const repo = new FakeRepo();
  const store = new FakeStore();
  const images = new FakeImages();
  const service = new MediaAssetService({
    repo,
    store,
    images,
    ...(overrides.maxBytes !== undefined ? { maxBytes: overrides.maxBytes } : {}),
    ...(overrides.maxPerInstance !== undefined ? { maxPerInstance: overrides.maxPerInstance } : {}),
  });
  return { repo, store, images, service };
}

const URL = 'http://multimedia.nt.qq.com.cn/download?fileid=x';

describe('MediaAssetService 存', () => {
  it('正常存：落盘 + 建记录，文件名是内容 hash', async () => {
    const { service, store, repo } = makeService();
    const outcome = await service.saveFromUrls({ instanceId: 'i1', alias: ' 猫猫 ', urls: [URL] });

    expect(outcome.kind).toBe('saved');
    const sha = createHash('sha256').update(PNG).digest('hex');
    expect(store.files.has(`assets/${sha}.png`)).toBe(true);
    expect(repo.rows[0]?.alias).toBe('猫猫');
    expect(repo.rows[0]?.bytes).toBe(PNG.byteLength);
  });

  it('同一张图存两个别名：文件只落一份', async () => {
    const { service, store, repo } = makeService();
    await service.saveFromUrls({ instanceId: 'i1', alias: '猫猫', urls: [URL] });
    const second = await service.saveFromUrls({ instanceId: 'i1', alias: '猫猫咪', urls: [URL] });

    expect(second.kind).toBe('saved');
    expect(second.kind === 'saved' && second.reusedFile).toBe(true);
    expect(store.files.size).toBe(1);
    expect(repo.rows).toHaveLength(2);
    expect(repo.rows[0]?.sha256).toBe(repo.rows[1]?.sha256);
  });

  it('重名拒绝，不覆盖', async () => {
    const { service, repo } = makeService();
    await service.saveFromUrls({ instanceId: 'i1', alias: '猫猫', urls: [URL] });
    const again = await service.saveFromUrls({ instanceId: 'i1', alias: '猫猫', urls: [URL] });

    expect(again).toEqual({ kind: 'rejected', reason: 'alias_taken' });
    expect(repo.rows).toHaveLength(1);
  });

  it('别名非法：空白/方括号/超长都拒', async () => {
    const { service } = makeService();
    for (const alias of ['', '   ', '猫[猫]', 'a b', 'x'.repeat(17)]) {
      const outcome = await service.saveFromUrls({ instanceId: 'i1', alias, urls: [URL] });
      expect(outcome, alias).toEqual({ kind: 'rejected', reason: 'bad_alias' });
    }
  });

  it('这条消息没有图：no_image，不抓网络', async () => {
    const { service, images } = makeService();
    const outcome = await service.saveFromUrls({ instanceId: 'i1', alias: '猫猫', urls: [] });
    expect(outcome).toEqual({ kind: 'rejected', reason: 'no_image' });
    expect(images.calls).toHaveLength(0);
  });

  it('图太大：too_large，不落盘', async () => {
    const { service, store } = makeService({ maxBytes: 4 });
    const outcome = await service.saveFromUrls({ instanceId: 'i1', alias: '猫猫', urls: [URL] });
    expect(outcome).toEqual({ kind: 'rejected', reason: 'too_large' });
    expect(store.files.size).toBe(0);
  });

  it('抓不到图：fetch_failed', async () => {
    const { service, images } = makeService();
    images.result = null;
    const outcome = await service.saveFromUrls({ instanceId: 'i1', alias: '猫猫', urls: [URL] });
    expect(outcome).toEqual({ kind: 'rejected', reason: 'fetch_failed' });
  });

  it('第一张失败会试第二张', async () => {
    const { service } = makeService();
    // 第一张是内网地址 → fetcher 返回 null；第二张正常
    const outcome = await service.saveFromUrls({
      instanceId: 'i1',
      alias: '猫猫',
      urls: ['http://127.0.0.1/a.jpg', URL],
    });
    expect(outcome.kind).toBe('saved');
  });

  it('超过实例上限：limit', async () => {
    const { service } = makeService({ maxPerInstance: 1 });
    await service.saveFromUrls({ instanceId: 'i1', alias: '猫猫', urls: [URL] });
    const second = await service.saveFromUrls({ instanceId: 'i1', alias: '狗子', urls: [URL] });
    expect(second).toEqual({ kind: 'rejected', reason: 'limit' });
  });
});

describe('MediaAssetService 取', () => {
  it('按别名解析出本地路径，并记账使用次数', async () => {
    const { service, repo } = makeService();
    await service.saveFromUrls({ instanceId: 'i1', alias: '猫猫', urls: [URL] });

    const resolved = await service.resolveForSend('i1', '猫猫');
    expect(resolved?.filePath).toContain('/media/assets/');
    expect(repo.used).toHaveLength(1);
  });

  it('名字不存在 / 文件丢了都返回 null（不让调用方区分）', async () => {
    const { service, store } = makeService();
    expect(await service.resolveForSend('i1', '不存在')).toBeNull();

    await service.saveFromUrls({ instanceId: 'i1', alias: '猫猫', urls: [URL] });
    store.files.clear();
    expect(await service.resolveForSend('i1', '猫猫')).toBeNull();
  });

  it('跨实例拿不到别人的素材', async () => {
    const { service } = makeService();
    await service.saveFromUrls({ instanceId: 'i1', alias: '猫猫', urls: [URL] });
    expect(await service.resolveForSend('i2', '猫猫')).toBeNull();
  });

  it('prompt 清单只给名字与标签', async () => {
    const { service } = makeService();
    await service.saveFromUrls({ instanceId: 'i1', alias: '猫猫', urls: [URL] });
    const list = await service.listForPrompt('i1', 12);
    expect(list).toEqual([{ alias: '猫猫', tags: '' }]);
  });
});

describe('别名规范化', () => {
  it('trim 后判长度与字符', () => {
    expect(MediaAssetService.normalizeAlias('  猫猫 ')).toBe('猫猫');
    expect(MediaAssetService.normalizeAlias('a/b')).toBeNull();
    expect(MediaAssetService.normalizeAlias('x'.repeat(16))).toHaveLength(16);
    expect(MediaAssetService.normalizeAlias('x'.repeat(17))).toBeNull();
  });
});
