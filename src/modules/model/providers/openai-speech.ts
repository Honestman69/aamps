/**
 * OpenAI 兼容的语音合成（`POST /audio/speech`，D033）。
 *
 * 与 `openai-compatible.ts` 分开的第二个协议入口：同一个 baseUrl、同一把 Key，
 * 但路径、请求体、响应体完全不同（返回的是音频二进制而不是 JSON）。
 * 硬塞进 chat 那个函数会让"文本补全"和"二进制流"两套错误处理纠缠在一起。
 *
 * 三家已确认兼容这个形状的：OpenAI（tts-1 / gpt-4o-mini-tts）、Azure OpenAI、
 * 以及多数中转的 `/v1/audio/speech`。DeepSeek 没有 TTS，所以语音用的是**另一把 Key**（D033）。
 *
 * 纪律与 chat 一致：Key 只进请求头；失败抛带状态码的错误，由调用方决定降级。
 */

import type { ProviderCallContext } from './openai-compatible';

export type SpeechRequest = {
  model: string;
  voice: string;
  /** 要念的文字 */
  input: string;
  /** mp3 在 QQ 侧兼容性最好（amr/silk 要看协议端转码） */
  format?: 'mp3' | 'opus' | 'aac' | 'wav';
};

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_INPUT_CHARS = 600;

export class SpeechFailedError extends Error {
  constructor(
    readonly status: number | null,
    readonly detail: string,
  ) {
    super(status ? `语音合成失败：HTTP ${status}` : '语音合成失败：网络错误');
    this.name = 'SpeechFailedError';
  }
}

function buildUrl(ctx: ProviderCallContext): string {
  const base = ctx.baseUrl.replace(/\/+$/, '');
  return `${base}/audio/speech`;
}

function buildHeaders(ctx: ProviderCallContext): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (ctx.authStyle === 'bearer') {
    headers.authorization = `Bearer ${ctx.apiKey}`;
  } else if (ctx.authStyle === 'x-api-key') {
    headers['x-api-key'] = ctx.apiKey;
  }
  return headers;
}

export async function openAiCompatibleSpeech(
  request: SpeechRequest,
  ctx: ProviderCallContext,
): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs || DEFAULT_TIMEOUT_MS);
  const onExternalAbort = (): void => controller.abort();
  ctx.signal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    const response = await fetch(buildUrl(ctx), {
      method: 'POST',
      headers: buildHeaders(ctx),
      body: JSON.stringify({
        model: request.model,
        voice: request.voice,
        input: request.input.slice(0, MAX_INPUT_CHARS),
        response_format: request.format ?? 'mp3',
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // 响应体可能含错误详情（也含厂商侧信息），只截取前 120 字用于日志，不外泄 key
      const detail = await response.text().catch(() => '');
      throw new SpeechFailedError(response.status, detail.slice(0, 120));
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0) {
      throw new SpeechFailedError(200, 'empty audio body');
    }
    return buffer;
  } catch (err) {
    if (err instanceof SpeechFailedError) {
      throw err;
    }
    throw new SpeechFailedError(null, 'network');
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener('abort', onExternalAbort);
  }
}
