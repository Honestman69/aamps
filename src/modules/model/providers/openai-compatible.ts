/**
 * OpenAI 兼容 Provider（DeepSeek / OpenAI / Moonshot / 智谱 / 百炼 / 中转 都走这一个）。
 *
 * 为什么手写 fetch 而不引 SDK：
 *   只用到 `POST /chat/completions` 一个端点；引 SDK 会带来"每家 SDK 各一套"的分裂，
 *   而这个项目的诉求是"换厂商只改 preset"（D006）。
 *
 * 三条纪律：
 *   1. **错误必须带状态码与响应体**抛给上层分类器，不要在这里吞掉或改写成笼统错误。
 *   2. **API Key 只出现在请求头**，不进日志、不进错误消息。
 *   3. 超时用 AbortController 控制，且要能被外部 signal 取消（用户锁定/停机时终止在途请求）。
 */

import type { ClassifiedError } from '../gateway/classify';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type ProviderChatRequest = {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens?: number;
};

export type ProviderChatResponse = {
  text: string;
  usage: { tokenIn: number; tokenOut: number };
  /** 厂商原始响应里的 model 字段（可能与请求不同，中转常会改写） */
  model: string;
};

export type ProviderCallContext = {
  baseUrl: string;
  apiKey: string;
  authStyle: 'bearer' | 'x-api-key' | 'query';
  apiVersion?: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
};

/** Provider 调用失败：带上分类结果，让 Gateway 决定重试/冷却/换 Key */
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number | null,
    readonly bodyText: string,
    readonly classified: ClassifiedError,
  ) {
    // 错误消息里只放状态码，绝不放 key 或完整响应体（body 可能含账号信息）
    super(status ? `provider 调用失败：HTTP ${status}` : 'provider 调用失败：网络错误');
    this.name = 'ProviderHttpError';
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

function buildHeaders(ctx: ProviderCallContext): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (ctx.authStyle === 'bearer') {
    headers.authorization = `Bearer ${ctx.apiKey}`;
  } else if (ctx.authStyle === 'x-api-key') {
    headers['x-api-key'] = ctx.apiKey;
  }
  if (ctx.apiVersion) {
    // Anthropic 需要 api-version/version 头；OpenAI 兼容厂商一般忽略
    headers['anthropic-version'] = ctx.apiVersion;
  }
  return headers;
}

function buildUrl(ctx: ProviderCallContext): string {
  const base = ctx.baseUrl.replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  if (ctx.authStyle === 'query') {
    // 少数中转要求把 key 放 query
    return `${url}?key=${encodeURIComponent(ctx.apiKey)}`;
  }
  return url;
}

import { classifyFailure } from '../gateway/classify';

export async function openAiCompatibleChat(
  request: ProviderChatRequest,
  ctx: ProviderCallContext,
): Promise<ProviderChatResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ctx.timeoutMs || DEFAULT_TIMEOUT_MS);
  const onExternalAbort = (): void => controller.abort();
  ctx.signal?.addEventListener('abort', onExternalAbort, { once: true });

  let response: Response;
  try {
    response = await fetch(buildUrl(ctx), {
      method: 'POST',
      headers: buildHeaders(ctx),
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        temperature: request.temperature,
        ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
        // 不要流式：M2 先跑通非流式链路，流式在表达层（M3）再开
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch {
    // 网络/超时/被取消：不区分原因，交给分类器统一按 network 处理
    throw new ProviderHttpError(null, '', classifyFailure({ networkError: true }));
  } finally {
    clearTimeout(timeout);
    ctx.signal?.removeEventListener('abort', onExternalAbort);
  }

  const bodyText = await response.text().catch(() => '');

  if (!response.ok) {
    throw new ProviderHttpError(
      response.status,
      bodyText,
      classifyFailure({ status: response.status, body: bodyText }),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    // 200 但返回非 JSON：中转/网关插了 HTML 错误页，属于 provider 异常
    throw new ProviderHttpError(200, bodyText.slice(0, 200), classifyFailure({ status: 502 }));
  }

  const data = parsed as {
    model?: string;
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const text = data.choices?.[0]?.message?.content ?? '';
  return {
    text,
    // 厂商不一定给 usage（部分中转省略），缺了就按 0 计，只统计能统计的
    usage: {
      tokenIn: data.usage?.prompt_tokens ?? 0,
      tokenOut: data.usage?.completion_tokens ?? 0,
    },
    model: data.model ?? request.model,
  };
}
