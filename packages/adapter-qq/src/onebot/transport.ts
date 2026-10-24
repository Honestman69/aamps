/**
 * OneBot 传输层抽象。
 *
 * 为什么要抽象：同一个协议有两种连接方向，收发逻辑完全一样，只有"谁发起连接"不同。
 *   - `client`：我们连 NapCat 的 WebSocket 服务端（正向）
 *   - `server`：NapCat 连我们的 WebSocket 服务端（反向）
 *
 * 选 server 的现实原因（2026-10-24 实测）：NapCat 4.18.41 的 `websocketServers`
 * token 校验是坏的（把 HTTP 中间件签名用在 WS 上，`next` 未定义 → 抛异常被吞 → 连接照常保留）。
 * 反向模式下 token 由**我们的** `verifyClient` 在握手阶段校验，不依赖上游实现。
 *
 * 附带好处：NapCat 主动出站，云上部署时服务器不需要开放任何入站端口。
 */

import type { OneBotActionResponse } from './protocol';

export type TransportKind = 'client' | 'server';

export interface OneBotTransport {
  readonly kind: TransportKind;

  /** 当前是否存在可发送的连接 */
  isOpen(): boolean;

  /**
   * 建立通道。
   * client 模式 = 拨号一次（失败抛错，不在这里重试）；
   * server 模式 = 启动监听并等待对端接入（超时抛错）。
   */
  connect(): Promise<void>;

  call(
    action: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<OneBotActionResponse>;

  /** 主动关闭，不再重连 */
  close(): void;
}
