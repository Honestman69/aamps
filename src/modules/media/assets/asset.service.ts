/**
 * 素材库服务（D034）：把"存一张图/表情"和"以后想用就用"这两件事做成基础设施。
 *
 * ## 为什么这件事不能交给 agent
 *
 * 模型没有文件系统，也没有跨轮自更新的持久化（`SelfState` 是反思任务写**文本**的，
 * 不该拿来存二进制）。它只能说"存了"，实际什么都不存在。再加两条：
 *
 * - **入站图片链接会过期**：QQ 图床的 url 带 rkey，几小时到几天就 404。不落盘 = 没存；
 * - **它记不住自己存过什么**：下次靠上下文猜名字，拼错就是"发送失败/发错图"，且不可复现。
 *
 * 所以：**存、去重、限额、解析全部在这里**，模型只负责说"把这个存成什么名字"和"用哪个名字"。
 *
 * ## 三条硬规则
 *
 * 1. **名字是唯一入口**（不是 URL）——模型不能凭空给外链当素材，SSRF 面因此为零；
 * 2. **重名拒绝，不覆盖**——覆盖会让"上次那个表情"神秘消失，是拟人系统里最难排查的一类 bug；
 * 3. **内容去重**：同一张图只落一份文件（`assets/<sha256>.<ext>`），但允许起多个别名
 *    （"猫猫震惊"和"猫咪震惊"本来就是同一张）。
 */

import { createHash } from 'node:crypto';

import type { IImageFetcher } from '../fetcher';
import type { IMediaFileStore } from '../file-store';
import type { IMediaAssetRepository, MediaAssetRecord } from './ports';

/** 每个实例最多存多少张：素材越多清单越挤，prompt 里塞不下也没人整理 */
export const MAX_ASSETS_PER_INSTANCE = 200;
/** 单张上限（比入站图片的 4MB 更保守：素材是长期占盘的） */
export const MAX_ASSET_BYTES = 2 * 1024 * 1024;
export const MAX_ALIAS_LENGTH = 16;

/** 别名：允许中文，禁止空白、方括号（会破坏标记语法）、路径字符 */
const ALIAS_PATTERN = /^[^\s[\]\\/:*?"<>|]{1,16}$/u;

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};

export type SaveRejectReason =
  | 'bad_alias'
  | 'alias_taken'
  | 'limit'
  | 'no_image'
  | 'fetch_failed'
  | 'too_large';

export type SaveOutcome =
  | { kind: 'saved'; asset: MediaAssetRecord; reusedFile: boolean }
  | { kind: 'rejected'; reason: SaveRejectReason };

export type ResolvedAsset = {
  asset: MediaAssetRecord;
  /** 可直接交给协议端的本地绝对路径 */
  filePath: string;
};

export class MediaAssetService {
  constructor(
    private readonly deps: {
      repo: IMediaAssetRepository;
      store: IMediaFileStore;
      images: IImageFetcher;
      clock?: () => Date;
      maxPerInstance?: number;
      maxBytes?: number;
    },
  ) {}

  private now(): Date {
    return this.deps.clock?.() ?? new Date();
  }

  /** 别名规范化：trim + 长度/字符校验。返回 null 表示不合法 */
  static normalizeAlias(raw: string): string | null {
    const alias = raw.trim();
    if (!alias || alias.length > MAX_ALIAS_LENGTH || !ALIAS_PATTERN.test(alias)) {
      return null;
    }
    return alias;
  }

  /**
   * 把这条消息里的图片存成素材。
   *
   * `urls` 是**当前这条消息**里的图片地址；按顺序取第一张能抓到的。
   * 只存消息里真实存在的东西——不接受模型自己编的链接。
   */
  async saveFromUrls(input: {
    instanceId: string;
    alias: string;
    urls: readonly string[];
    tags?: string;
  }): Promise<SaveOutcome> {
    const alias = MediaAssetService.normalizeAlias(input.alias);
    if (!alias) {
      return { kind: 'rejected', reason: 'bad_alias' };
    }

    const maxPerInstance = this.deps.maxPerInstance ?? MAX_ASSETS_PER_INSTANCE;
    if ((await this.deps.repo.countUsable(input.instanceId)) >= maxPerInstance) {
      return { kind: 'rejected', reason: 'limit' };
    }

    if (input.urls.length === 0) {
      return { kind: 'rejected', reason: 'no_image' };
    }

    const maxBytes = this.deps.maxBytes ?? MAX_ASSET_BYTES;
    let fetched: { data: Buffer; mime: string } | null = null;
    let sawTooLarge = false;
    for (const url of input.urls) {
      const image = await this.deps.images.fetch(url);
      if (!image) {
        continue;
      }
      if (image.data.byteLength > maxBytes) {
        sawTooLarge = true;
        continue;
      }
      fetched = image;
      break;
    }
    if (!fetched) {
      return { kind: 'rejected', reason: sawTooLarge ? 'too_large' : 'fetch_failed' };
    }

    const sha256 = createHash('sha256').update(fetched.data).digest('hex');
    const ext = EXT_BY_MIME[fetched.mime] ?? 'jpg';
    const reused = (await this.deps.repo.findBySha(input.instanceId, sha256)) !== null;

    if (!reused) {
      // 只有内容第一次出现时才落盘：同一张图不会存两遍
      await this.deps.store.write('assets', sha256, ext, fetched.data);
    }

    const created = await this.deps.repo.create({
      instanceId: input.instanceId,
      alias,
      sha256,
      ext,
      mime: fetched.mime,
      bytes: fetched.data.byteLength,
      source: 'inbound',
      ...(input.tags ? { tags: input.tags } : {}),
    });
    if (!created.ok) {
      return { kind: 'rejected', reason: created.reason };
    }
    return { kind: 'saved', asset: created.asset, reusedFile: reused };
  }

  /**
   * 按别名取一张可发送的素材。
   *
   * 返回 null 的两种情况都当"没有这张"处理（不让调用方区分，避免把内部状态漏进对话）：
   * 名字不存在 / 记录在但文件丢了（用户手工删了 data/media）。
   */
  async resolveForSend(instanceId: string, alias: string): Promise<ResolvedAsset | null> {
    const normalized = MediaAssetService.normalizeAlias(alias);
    if (!normalized) {
      return null;
    }
    const asset = await this.deps.repo.findByAlias(instanceId, normalized);
    if (!asset) {
      return null;
    }
    const filePath = await this.deps.store.find('assets', asset.sha256, asset.ext);
    if (!filePath) {
      return null;
    }
    await this.deps.repo.markUsed(instanceId, asset.id, this.now()).catch(() => undefined);
    return { asset, filePath };
  }

  /** prompt 里的清单：只给名字与标签，不给路径与 hash */
  async listForPrompt(instanceId: string, limit = 12): Promise<Array<{ alias: string; tags: string }>> {
    const rows = await this.deps.repo.listUsable(instanceId, limit);
    return rows.map((row) => ({ alias: row.alias, tags: row.tags }));
  }
}
