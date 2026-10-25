/**
 * 入站图片 → 模型可读的 data URL（D033）。
 *
 * 为什么不直接把 QQ 的图片链接塞给模型：多数厂商的 vision 接口**不会**帮你去下载外链，
 * 它们要么要求 base64，要么要求可公网访问且格式合法的 URL。QQ 图床的链接带 rkey、
 * 有时效、还常常是 http，直接给过去大概率 400。所以由我们下载一次，转成 data URL。
 *
 * ## 三条约束
 *
 * 1. **单张 4MB 上限**。再大就只发占位文本：一张图吃掉几万 token，比不回更糟。
 * 2. **超时 8 秒**。抓图是主链路上的同步等待，慢了宁可放弃这张图。
 * 3. **只接受 public 地址**（见 `image-url.ts`）。入站允许 http，因为 QQ 图床就是 http。
 */

import { checkRemoteUrl } from './image-url';

export type InboundImage = {
  /** `data:image/jpeg;base64,...` */
  dataUrl: string;
  bytes: number;
};

export interface IImageFetcher {
  /** 失败返回 null（永远不 throw）：少一张图不能让整条消息处理失败 */
  fetchAsDataUrl(url: string): Promise<InboundImage | null>;
}

export const MAX_INBOUND_IMAGE_BYTES = 4 * 1024 * 1024;
export const INBOUND_IMAGE_TIMEOUT_MS = 8_000;

export class HttpImageFetcher implements IImageFetcher {
  constructor(
    private readonly options: { timeoutMs?: number; maxBytes?: number } = {},
  ) {}

  async fetchAsDataUrl(url: string): Promise<InboundImage | null> {
    // 适配器可能已经给了 base64（部分 OneBot 实现会把小图内联）
    if (url.startsWith('data:image/')) {
      return { dataUrl: url, bytes: Math.floor((url.length * 3) / 4) };
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
      const buffer = Buffer.from(await response.arrayBuffer());
      // 头里没写长度时只能下完再看，所以这条检查不能省
      if (buffer.byteLength === 0 || buffer.byteLength > maxBytes) {
        return null;
      }
      return {
        dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
        bytes: buffer.byteLength,
      };
    } catch {
      // 超时/断网/被取消：当作"这张图没拿到"
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
