/**
 * 反向 WebSocket：**我们做服务端，NapCat 连进来**。
 *
 * 为什么选这个方向（2026-10-24 实测之后定的）：
 *   1. NapCat 4.18.41 的 `websocketServers` 不校验 token（把 HTTP 中间件的
 *      `authorize(token, req, res, next)` 用在 WS 上，`next` 未定义 → 抛异常被吞 → 连接保留）。
 *      反向模式下 token 由我们的 `verifyClient` 在**握手阶段**校验，不依赖上游实现。
 *   2. 云端部署时不需要开放任何入站端口：NapCat 在家里主动往外连。
 *
 * 状态语义（和 client 模式一致，但要注意区别）：
 *   `online`     = 对端已连入，可以直接 call
 *   `connecting` = 监听中、等对端连入（NapCat 重启期间就是这个状态）
 *   `offline`    = 已主动关闭
 */

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

import type { ClientLogger } from './client';
import { rejectAllPending, routeIncoming, type PendingEntry } from './incoming';
import type { OneBotActionResponse, OneBotEvent } from './protocol';
import type { OneBotTransport } from './transport';

export type OneBotServerOptions = {
  host: string;
  port: number;
  /**
   * 必填：对端 token 的校验器。
   *
   * 为什么不是一个 `accessToken` 字符串：反向监听发生在服务启动时，
   * 那时用户还没登录、DEK 不在内存，拿不到明文 token。主服务手里有一份
   * HMAC 摘要，足以回答"这个 token 对不对"，校验算法留在主服务侧。
   * （适配器不读环境变量、不碰密钥，见 D013。）
   */
  verifyToken: (provided: string) => boolean;
  logger: ClientLogger;
  onEvent: (event: OneBotEvent) => void;
  onStatusChange?: (status: 'connecting' | 'online' | 'offline') => void;
  /** 等待对端连入的时间（NapCat 主动连过来，通常几秒内） */
  waitForPeerMs?: number;
  requestTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
};

const DEFAULTS = {
  waitForPeerMs: 20_000,
  requestTimeoutMs: 10_000,
  heartbeatIntervalMs: 30_000,
  heartbeatTimeoutMs: 10_000,
};

/** 字符串常量时间比较（导出给适配器做"明文兜底"用） */
export function constantTimeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export class OneBotWsServer implements OneBotTransport {
  readonly kind = 'server' as const;

  private wss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, PendingEntry>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  /** 等待对端连入的挂起 promise。close() 时必须显式收掉，否则会留下一个迟到的 reject */
  private peerWaiter: {
    resolve: () => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;
  private seq = 0;
  private closedByUser = false;

  constructor(private readonly options: OneBotServerOptions) {
    if (typeof options.verifyToken !== 'function') {
      throw new Error('反向 WS 必须提供 token 校验器：没有校验的监听等于对任何能连上的人开放');
    }
  }

  isOpen(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    this.closedByUser = false;
    this.options.onStatusChange?.('connecting');
    await this.startListening();
    await this.waitForPeer();
  }

  close(): void {
    this.closedByUser = true;
    this.stopHeartbeat();
    this.settlePeerWait(new Error('已主动关闭反向 WS，不再等待对端连入'));
    rejectAllPending(this.pending, new Error('连接已关闭'));

    if (this.socket) {
      try {
        this.socket.close(1000, 'server closing');
      } catch {
        // 已经断了
      }
      this.socket = null;
    }
    if (this.wss) {
      const server = this.wss;
      this.wss = null;
      // 先断连接再关监听，否则 close 会一直等
      for (const client of server.clients) {
        client.terminate();
      }
      server.close();
    }
    this.options.onStatusChange?.('offline');
  }

  async call(
    action: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = this.options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
  ): Promise<OneBotActionResponse> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('OneBot 连接未就绪（对端尚未连入）');
    }
    this.seq += 1;
    const echo = `aamps-${this.seq}`;

    return await new Promise<OneBotActionResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot 调用超时：${action}`));
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      socket.send(JSON.stringify({ action, params, echo }), (err) => {
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

  private async startListening(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const server = new WebSocketServer({
        host: this.options.host,
        port: this.options.port,
        verifyClient: (info, done) => {
          const allowed = this.isPeerAllowed(info.req as IncomingMessage);
          if (!allowed) {
            this.options.logger.warn(
              { event: 'adapter.peer_rejected', reason: 'token_mismatch' },
              '对端 token 校验失败，已拒绝握手',
            );
          }
          done(allowed, allowed ? undefined : 401, allowed ? undefined : 'token verify failed');
        },
      });

      server.once('listening', () => resolve());
      server.once('error', (err: NodeJS.ErrnoException) => {
        // listen 失败时不要把半成品留在 this.wss 上，否则之后的 close() 会对
        // 一个没跑起来的 server 调 close，反过来又抛 "The server is not running"
        if (this.wss === server) {
          this.wss = null;
        }
        const hint = err.code === 'EADDRINUSE' ? '（端口被占用）' : '';
        reject(new Error(`启动反向 WS 监听失败：${err.message}${hint}`));
      });
      server.on('connection', (socket) => this.attach(socket));

      this.wss = server;
      this.options.logger.info(
        { event: 'adapter.listening', port: this.options.port },
        '反向 WS 已监听，等待 NapCat 连入',
      );
    });
  }

  private waitForPeer(): Promise<void> {
    if (this.isOpen()) {
      return Promise.resolve();
    }
    const waitMs = this.options.waitForPeerMs ?? DEFAULTS.waitForPeerMs;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.peerWaiter = null;
        reject(
          new Error(
            `等待 NapCat 连入超时（${waitMs}ms）。请确认 NapCat 的「反向 WebSocket」地址指向 ` +
              `ws://${this.options.host}:${this.options.port}，且 token 与实例一致`,
          ),
        );
      }, waitMs);
      timer.unref?.();
      this.peerWaiter = {
        resolve,
        reject,
        timer,
      };
    });
  }

  /** 收掉挂起的"等对端"promise：成功、超时、主动关闭三条路都必须走这里 */
  private settlePeerWait(err?: Error): void {
    const waiter = this.peerWaiter;
    if (!waiter) {
      return;
    }
    this.peerWaiter = null;
    clearTimeout(waiter.timer);
    if (err) {
      waiter.reject(err);
    } else {
      waiter.resolve();
    }
  }

  private isPeerAllowed(req: IncomingMessage): boolean {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const fromQuery = url.searchParams.get('access_token') ?? '';
    const fromHeader = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const provided = fromQuery || fromHeader;
    if (!provided) {
      return false;
    }
    return this.options.verifyToken(provided);
  }

  private attach(socket: WebSocket): void {
    if (this.closedByUser) {
      socket.close(1001, 'server closed');
      return;
    }
    // 同一实例只认一条连接：NapCat 重连时会先建新连接，旧的必须让位，
    // 否则两条通道同时存在 → 同一条消息被处理两次
    if (this.socket && this.socket !== socket) {
      try {
        this.socket.close(1000, 'replaced by new connection');
      } catch {
        // 忽略
      }
    }
    this.socket = socket;

    socket.on('message', (data) => {
      routeIncoming(data, {
        pending: this.pending,
        onEvent: this.options.onEvent,
        logger: this.options.logger,
      });
    });
    socket.on('close', () => {
      if (this.socket === socket) {
        this.socket = null;
        rejectAllPending(this.pending, new Error('对端连接已断开'));
        this.stopHeartbeat();
        this.options.onStatusChange?.('connecting');
      }
    });
    socket.on('error', (err) => {
      this.options.logger.warn({ event: 'adapter.ws_error', reason: err.message }, '对端连接异常');
    });

    this.options.logger.info({ event: 'adapter.peer_connected' }, 'NapCat 已连入');
    this.options.onStatusChange?.('online');
    this.startHeartbeat();
    this.settlePeerWait();
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
        this.options.logger.warn({ event: 'adapter.heartbeat_timeout' }, '心跳超时，断开等待重连');
        this.socket?.terminate();
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
