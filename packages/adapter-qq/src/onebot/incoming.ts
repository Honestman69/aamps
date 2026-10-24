/**
 * 入站报文的统一分发：client / server 两种传输共用同一套 echo 匹配与事件路由。
 * 抽出来的原因：两份实现里任何一处漏了 `echo` 匹配，就会变成"发出去的请求永远等不到响应"，
 * 而这种 bug 在测试里跑一次是看不出来的（要等 10 秒超时）。
 */

import type { ClientLogger } from './client';
import type { OneBotActionResponse, OneBotEvent } from './protocol';

export type PendingEntry = {
  resolve: (value: OneBotActionResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

export type RouteOptions = {
  pending: Map<string, PendingEntry>;
  onEvent: (event: OneBotEvent) => void;
  logger: ClientLogger;
};

/** 解析一帧并分发：带 `echo` 的是某个 action 的响应，带 `post_type` 的是事件 */
export function routeIncoming(data: unknown, options: RouteOptions): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(data));
  } catch {
    options.logger.warn({ event: 'adapter.bad_json' }, '收到非 JSON 数据，已丢弃');
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return;
  }
  const envelope = parsed as Record<string, unknown>;

  if (typeof envelope.echo === 'string') {
    const entry = options.pending.get(envelope.echo);
    if (entry) {
      clearTimeout(entry.timer);
      options.pending.delete(envelope.echo);
      entry.resolve(envelope as OneBotActionResponse);
    }
    return;
  }

  if (typeof envelope.post_type === 'string') {
    options.onEvent(envelope as OneBotEvent);
  }
}

/** 清空所有等待中的请求（连接断开时必须做，否则每个调用方都要等满超时才失败） */
export function rejectAllPending(pending: Map<string, PendingEntry>, err: Error): void {
  for (const [echo, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(err);
    pending.delete(echo);
  }
}
