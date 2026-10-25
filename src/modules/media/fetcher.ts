/**
 * 图片抓取：远程 URL → 原始字节（以及给模型用的 data URL）。
 *
 * ## 为什么要下载而不是把链接丢给模型
 *
 * 多数厂商的 vision 接口**不会**帮你去下载外链，要么要 base64、要么要可公网访问且格式合法的 URL。
 * QQ 图床的链接带 rkey、有时效、还常常是 http，直接给过去大概率 400。
 *
 * ## 三条约束
 *
 * 1. **单张 4MB 上限**。再大就放弃：一张图吃掉几万 token，比不回更糟。
 * 2. **超时 8 秒**。抓图在主链路上是同步等待，慢了宁可放弃这张图。
 * 3. **只接受 public 地址**（见 `image-url.ts`）。入站允许 http，因为 QQ 图床就是 http。
 *
 * 素材库（`assets/`）复用同一个抓取器：**入站图片链接会过期**，不落盘等于没存。
 */

import { checkRemoteUrl } from './image-url';

export type FetchedImage = {
  data: Buffer;
  /** 例如 `image/jpeg` */
  mime: string;
};

export type InboundImage = {
  /** `data:image/jpeg;base64,...` */
  dataUrl: string;
  bytes: number;
};

export interface IImageFetcher {
  /** 取原始字节；失败返回 null（永远不 throw） */
  fetch(url: string): Promise<FetchedImage | null>;

  /** 取模型可读的 data URL；失败返回 null */
  fetchAsDataUrl(url: string): Promise<InboundImage | null>;
}

export const MAX_INBOUND_IMAGE_BYTES = 4 * 1024 * 1024;
export const INBOUND_IMAGE_TIMEOUT_MS = 8_000;

/** 从 `data:image/png;base64,AAA` 解出字节；不是这个形状返回 null */
function decodeDataUrl(url: string): FetchedImage | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!match) {
    return null;
  }
  try {
    return { mime: match[1] ?? 'image/jpeg', data: Buffer.from(match[2] ?? '', 'base64') };
  } catch {
    return null;
  }
}

export class HttpImageFetcher implements IImageFetcher {
  constructor(private readonly options: { timeoutMs?: number; maxBytes?: number } = {}) {}

  async fetch(url: string): Promise<FetchedImage | null> {
    // 适配器可能已经给了 base64（部分 OneBot 实现会把小图内联）
    if (url.startsWith('data:image/')) {
      return decodeDataUrl(url);
    }

    const check = checkRemoteUrl(url, { allowHttp: true, allowHosts: [] });
    if (!check.ok) {
      return null;
    }

    const maxBytes = this.options.maxBytes ?? MAX_INBOUND_IMAGE_BYTES;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? INBOUND_IMAGE_TIMEOUT_MS,
    );

    try {
      const response = await fetch(check.url, { signal: controller.signal, redirect: 'follow' });
      if (!response.ok) {
        return null;
      }
      const mime = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
      if (!mime.startsWith('image/')) {
        return null;
      }
      const declared = Number(response.headers.get('content-length') ?? '');
      if (Number.isFinite(declared) && declared > maxBytes) {
        return null;
      }
      const data = Buffer.from(await response.arrayBuffer());
      // 头里没写长度时只能下完再看，所以这条检查不能省
      if (data.byteLength === 0 || data.byteLength > maxBytes) {
        return null;
      }
      return { data, mime };
    } catch {
      // 超时/断网/被取消：当作"这张图没拿到"
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchAsDataUrl(url: string): Promise<InboundImage | null> {
    const image = await this.fetch(url);
    if (!image) {
      return null;
    }
    return {
      dataUrl: `data:${image.mime};base64,${image.data.toString('base64')}`,
      bytes: image.data.byteLength,
    };
  }
}
