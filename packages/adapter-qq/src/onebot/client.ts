/**
 * OneBot 11 WebSocket 客户端（我们主动连 NapCat 提供的 WS 地址）。
 *
 * 为什么不用现成的 OneBot SDK：
 *   1. 它们的重连/心跳策略写死，而我们要把"连续失败 10 次就停"上报给风控模块（见 D008）；
 *   2. 它们通常把原始事件直接回调出去，正好违反"业务不认识 OneBot"这条铁律；
 *   3. 依赖越少越好——封号风险已经是架构级问题，不想再叠一层上游行为的不可控。
 *
 * 连接语义：
 *   - `connect()` **只尝试一次**，失败就抛错。这样后台点"连接"能立刻看到原因，而不是转圈。
 *   - 连上之后的**意外断开**会自动重连（指数退避），这时的失败不会抛给谁，只上报事件。
 */

import WebSocket from 'ws';

import type { AdapterDeps } from '@newjob/contracts';
import { rejectAllPending as rejectPending, routeIncoming, type PendingEntry } from './incoming';
import type { OneBotActionResponse, OneBotEvent } from './protocol';
import type { OneBotTransport } from './transport';

export type ClientLogger = AdapterDeps['logger'];

export type OneBotClientOptions = {
  url: string;
  /** 留空表示 NapCat 侧未开鉴权 */
  accessToken?: string;
  logger: ClientLogger;
  onEvent: (event: OneBotEvent) => void;
  onStatusChange?: (status: 'connecting' | 'online' | 'offline') => void;
  /** 每个连接内主动探测间隔 */
  heartbeatIntervalMs?: number;
  /** 探测超时：超过就认为连接假死，主动断开以便重连 */
  heartbeatTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** 连续失败多少次后放弃（0 = 永不放弃） */
  maxReconnectAttempts?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
};

const DEFAULTS = {
  heartbeatIntervalMs: 30_000,
  heartbeatTimeoutMs: 10_000,
  requestTimeoutMs: 10_000,
  maxReconnectAttempts: 10,
  reconnectBaseMs: 1_000,
  reconnectMaxMs: 30_000,
};

export class OneBotWsClient implements OneBotTransport {
  readonly kind = 'client' as const;

  private ws: WebSocket | null = null;
  private closedByUser = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private seq = 0;
  private readonly pending = new Map<string, PendingEntry>();

  constructor(private readonly options: OneBotClientOptions) {}

  /** 是否处于可发送状态 */
  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** 只尝试一次。失败直接抛，交给调用方决定是否重试 */
  async connect(): Promise<void> {
    this.closedByUser = false;
    this.options.onStatusChange?.('connecting');

    const ws = new WebSocket(this.buildUrl(), {
      headers: this.options.accessToken
        ? { authorization: `Bearer ${this.options.accessToken}` }
        : {},
      handshakeTimeout: this.options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
    });
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        cleanup();
        reject(new Error(`连接 OneBot 失败：${err.message}`));
      };
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const cleanup = (): void => {
        ws.off('error', onError);
        ws.off('open', onOpen);
      };
      ws.once('open', onOpen);
      ws.once('error', onError);
    });

    this.reconnectAttempts = 0;
    this.options.onStatusChange?.('online');
    this.options.logger.info({ event: 'adapter.connected' }, 'OneBot 连接已建立');

    ws.on('message', (data) => {
      routeIncoming(data, {
        pending: this.pending,
        onEvent: this.options.onEvent,
        logger: this.options.logger,
      });
    });
    ws.on('close', (code) => this.handleClose(code));
    ws.on('error', (err) => {
      // 已连接后的错误：记一条就够，关闭事件会跟着来
      this.options.logger.warn({ event: 'adapter.ws_error', reason: err.message }, 'OneBot 连接异常');
    });

    this.startHeartbeat();
  }

  /** 主动关闭，不再重连 */
  close(): void {
    this.closedByUser = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    rejectPending(this.pending, new Error('连接已关闭'));
    if (this.ws) {
      try {
        this.ws.close(1000, 'client disconnect');
      } catch {
        // 已经断了，忽略
      }
      this.ws = null;
    }
    this.options.onStatusChange?.('offline');
  }

  /** 调用 OneBot API（send_msg / delete_msg / get_status …） */
  async call(
    action: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = this.options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
  ): Promise<OneBotActionResponse> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('OneBot 连接未就绪');
    }
    this.seq += 1;
    const echo = `aamps-${this.seq}`;

    return await new Promise<OneBotActionResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot 调用超时：${action}`));
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      this.ws?.send(JSON.stringify({ action, params, echo }), (err) => {
        if (err) {
          const entry = this.pending.get(echo);
          if (entry) {
            clearTimeout(entry.timer);
            this.pending.delete(echo);
          }
          reject(new Error(`发送失败：${err.message}`));
        }
      });
    });
  }

  private buildUrl(): string {
    if (!this.options.accessToken) {
      return this.options.url;
    }
    // 两种鉴权方式同时给上：不同 OneBot 实现认的字段不一样
    const separator = this.options.url.includes('?') ? '&' : '?';
    return `${this.options.url}${separator}access_token=${encodeURIComponent(this.options.accessToken)}`;
  }

  private handleClose(code: number): void {
    this.stopHeartbeat();
    rejectPending(this.pending, new Error(`连接已关闭（code=${code}）`));
    this.options.onStatusChange?.('offline');
    if (this.closedByUser) {
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const max = this.options.maxReconnectAttempts ?? DEFAULTS.maxReconnectAttempts;
    if (max > 0 && this.reconnectAttempts >= max) {
      this.options.logger.error(
        { event: 'adapter.reconnect_giveup', attempts: this.reconnectAttempts },
        '重连次数达到上限，请检查 NapCat 是否在运行',
      );
      return;
    }
    this.reconnectAttempts += 1;
    const base = this.options.reconnectBaseMs ?? DEFAULTS.reconnectBaseMs;
    const cap = this.options.reconnectMaxMs ?? DEFAULTS.reconnectMaxMs;
    const delay = Math.min(base * 2 ** (this.reconnectAttempts - 1), cap);

    this.options.logger.warn(
      { event: 'adapter.reconnect_scheduled', attempt: this.reconnectAttempts, delayMs: delay },
      '连接断开，准备重连',
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err: Error) => {
        this.options.logger.warn(
          { event: 'adapter.reconnect_failed', attempt: this.reconnectAttempts, reason: err.message },
          '重连失败',
        );
        this.scheduleReconnect();
      });
    }, delay);
    // 定时器不应阻止进程退出
    this.reconnectTimer.unref?.();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const interval = this.options.heartbeatIntervalMs ?? DEFAULTS.heartbeatIntervalMs;
    const timeout = this.options.heartbeatTimeoutMs ?? DEFAULTS.heartbeatTimeoutMs;
    if (interval <= 0) {
      return;
    }
    this.heartbeatTimer = setInterval(() => {
      this.call('get_status', {}, timeout).catch(() => {
        this.options.logger.warn({ event: 'adapter.heartbeat_timeout' }, '心跳超时，主动断开以重连');
        // 主动断开 → 触发 close → 自动重连
        this.ws?.terminate();
      });
    }, interval);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

}
