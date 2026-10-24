/**
 * OneBot 11 适配器（QQ）。
 *
 * 职责边界（D013）：只做"协议翻译 + 连接管理 + 发送节流"。
 * 不认识数据库、不读 DEK、不做重试策略以外的业务判断、不回业务话术。
 * 配置由主服务解密好放在 `deps.config` 里传进来，本文件不读任何环境变量。
 *
 * 支持的配置项就是 `manifest.configFields` 里那三个：
 *   wsUrl / accessToken / selfId
 */

import type {
  AdapterDeps,
  AdapterEvent,
  AdapterStatus,
  IAdapter,
  InboundMessage,
  OutboundAction,
  PlatformEvent,
} from '@newjob/contracts';
import { manifest } from './manifest';
import { OneBotWsClient } from './onebot/client';
import { toInboundMessage, toPlatformEvent } from './onebot/convert';
import { toOneBotCall } from './onebot/outbound';
import { idToString, type OneBotEvent } from './onebot/protocol';
import { OneBotWsServer, constantTimeEqualString } from './onebot/server';
import type { OneBotTransport } from './onebot/transport';
import { TokenBucket, bucketFromRateHint } from './throttle';

export type OneBotMode = 'client' | 'server';

export type OneBotConfig = {
  /**
   * 连接方向。
   *   `server`（推荐）= NapCat 连我们，token 由我们校验
   *   `client`         = 我们连 NapCat（NapCat 4.18.41 的 WS token 校验有 bug，等于无鉴权）
   */
  mode: OneBotMode;
  /** client: 对方地址；server: 本端监听地址（如 ws://127.0.0.1:3002） */
  wsUrl: string;
  accessToken?: string;
  selfId: string;
};

/** 校验并归一配置。错误信息里**不允许**出现 token */
export function parseOneBotConfig(config: Record<string, unknown>): OneBotConfig {
  const rawMode = typeof config.mode === 'string' ? config.mode.trim().toLowerCase() : '';
  const mode: OneBotMode = rawMode === 'client' ? 'client' : 'server';

  const wsUrl = typeof config.wsUrl === 'string' ? config.wsUrl.trim() : '';
  if (!wsUrl) {
    throw new Error(
      mode === 'server'
        ? '缺少监听地址：请填写本端要监听的 ws:// 地址（如 ws://127.0.0.1:3002）'
        : '缺少 wsUrl：请填写 NapCat 的 WebSocket 地址',
    );
  }
  if (!/^wss?:\/\//i.test(wsUrl)) {
    throw new Error('wsUrl 必须以 ws:// 或 wss:// 开头');
  }
  const selfId = idToString(config.selfId).trim();
  if (!selfId) {
    throw new Error('缺少 selfId：请填写这个实例对应的 QQ 号');
  }
  const accessToken =
    typeof config.accessToken === 'string' && config.accessToken.trim()
      ? config.accessToken.trim()
      : undefined;

  // 注意：这里**不再**强制反向模式必须有明文 token。
  // 监听发生在服务启动时，那时 DEK 不在内存里，主服务可能只持有 token 摘要
  // （见 contracts 的 `AdapterDeps.verifyPeerToken`）。"有没有校验手段"由
  // `createTransport` 在装配时判定，配置解析只管格式。
  return { mode, wsUrl, accessToken, selfId };
}

/** QQ 号掩码：错误信息可能被写进日志，完整号不许出现 */
function maskId(id: string): string {
  return id.length <= 4 ? '****' : `${id.slice(0, 2)}****${id.slice(-2)}`;
}

export class OneBotAdapter implements IAdapter {
  readonly platform: 'qq' = 'qq';
  readonly protocol: 'onebot' = 'onebot';
  readonly capabilities = manifest.capabilities;

  private status: AdapterStatus = 'offline';
  private transport: OneBotTransport | null = null;
  private bucket: TokenBucket;
  private messageHandler: ((msg: InboundMessage) => void) | null = null;
  private platformEventHandler: ((evt: PlatformEvent) => void) | null = null;
  private adapterEventHandler: ((evt: AdapterEvent) => void) | null = null;

  constructor(private readonly deps: AdapterDeps) {
    // 节流参数取自能力声明，不写死：换平台/换协议时只改 capabilities
    this.bucket = bucketFromRateHint(this.capabilities.rateLimitHint);
  }

  async connect(): Promise<void> {
    if (this.transport) {
      await this.disconnect();
    }
    const config = parseOneBotConfig(this.deps.config);
    const transport = this.createTransport(config);

    this.transport = transport;
    try {
      await transport.connect();
      // 连上 ≠ 登对了。必须核对登录的是哪个号，否则填错号会表现为"接上了但没反应"
      await this.verifyLogin(transport, config.selfId);
    } catch (err) {
      // 关键：失败要真的断开，否则留下一条半开的 WS，NapCat 侧会认为是活连接
      transport.close();
      this.transport = null;
      this.status = 'offline';
      this.emit({ kind: 'status', status: 'offline' });
      throw err;
    }
  }

  /**
   * 按 mode 建传输层。
   *   server：我们监听，NapCat 连进来（token 由我们的 verifyClient 在握手阶段校验）
   *   client：我们连 NapCat（注意 4.18.41 的 token 校验是坏的，只能靠 127.0.0.1 兜底）
   */
  private createTransport(config: OneBotConfig): OneBotTransport {
    const onEvent = (event: OneBotEvent): void => this.handleEvent(event, config.selfId);
    const onStatusChange = (status: 'connecting' | 'online' | 'offline'): void => {
      this.status = status;
      this.emit({ kind: 'status', status: this.status });
    };

    if (config.mode === 'server') {
      const url = new URL(config.wsUrl);
      const port = Number(url.port);
      if (!Number.isInteger(port) || port <= 0) {
        throw new Error('反向模式的监听地址必须带端口（如 ws://127.0.0.1:3002）');
      }
      return new OneBotWsServer({
        // 只监听回环/内网地址：反向模式的绑定地址不应该出现在公网上
        host: url.hostname || '127.0.0.1',
        port,
        verifyToken: this.resolvePeerVerifier(config.accessToken),
        logger: this.deps.logger,
        onEvent,
        onStatusChange,
      });
    }

    return new OneBotWsClient({
      url: config.wsUrl,
      ...(config.accessToken ? { accessToken: config.accessToken } : {}),
      logger: this.deps.logger,
      onEvent,
      onStatusChange,
    });
  }

  /**
   * 反向模式的 token 校验器。
   *
   * 优先用主服务注入的（它手里是 HMAC 摘要，服务启动时不需要 DEK 也能校验）；
   * 没有注入时退回"与明文比对"，供单机测试和还没有摘要的老数据使用。
   * 两者都没有 → 直接拒绝启动，绝不出现"监听了但不校验"的窗口。
   */
  private resolvePeerVerifier(plainToken?: string): (provided: string) => boolean {
    if (this.deps.verifyPeerToken) {
      return this.deps.verifyPeerToken;
    }
    if (plainToken) {
      return (provided: string) => constantTimeEqualString(provided, plainToken);
    }
    throw new Error(
      '反向模式缺少 token 校验手段：实例未保存 Access Token，调用方也没有注入 verifyPeerToken',
    );
  }

  /**
   * 登录身份核验（对比 QQ-bot 项目的踩坑记录后补的）。
   *
   * 为什么不能只看 WS 是否连上：
   *   1. NapCat 进程活着、WS 也通，但 QQ 账号可能已经掉线 —— 此时不该报"在线"；
   *   2. 更糟的是登的可能是**另一个号**：`selfId` 用来判断"有没有被 @"和过滤自身消息，
   *      号不对就全错，而现象只是"机器人不理人"。
   *
   * 用 `get_login_info` 拿实际登录的号（注意：它只有 user_id / nickname，没有在线状态），
   * 用 `get_status` 拿 online（部分实现还有 good，表示接收链路健康度）。
   */
  private async verifyLogin(transport: OneBotTransport, expectedSelfId: string): Promise<void> {
    const loginInfo = await transport.call('get_login_info', {});
    const loginData = (loginInfo.data ?? {}) as Record<string, unknown>;
    const actualId = idToString(loginData.user_id);

    if (!actualId) {
      throw new Error('无法通过 get_login_info 读取登录账号，请检查 NapCat 的 OneBot 实现是否完整');
    }
    if (actualId !== expectedSelfId) {
      // 报错信息里放掩码，不放完整 QQ 号（硬性规则 6：完整号不进日志）
      throw new Error(
        `登录的账号与实例配置不一致：当前登录 ${maskId(actualId)}，实例填写 ${maskId(expectedSelfId)}。` +
          `请到 NapCat 确认登录的号，或修改实例的 QQ 号后再连接`,
      );
    }

    const statusResult = await transport.call('get_status', {});
    const statusData = (statusResult.data ?? {}) as Record<string, unknown>;
    if (statusData.online === false) {
      throw new Error('QQ 账号当前未登录（NapCat 在线但账号已离线），请在 NapCat 里重新登录');
    }
    if (statusData.good === false) {
      // 接收链路不健康：WS 通着但可能收不到消息。不阻断连接，但必须留痕
      this.emit({
        kind: 'error',
        message: 'NapCat 自评接收链路不健康（status.good=false），可能收不到消息',
      });
    }
  }

  async disconnect(): Promise<void> {
    this.transport?.close();
    this.transport = null;
    this.status = 'offline';
    this.emit({ kind: 'status', status: 'offline' });
  }

  async send(action: OutboundAction): Promise<{ messageId: string }> {
    if (!this.transport || !this.transport.isOpen()) {
      throw new Error('未连接，无法发送');
    }
    // 节流放在最前面：连接层只管连通性，频率是业务约束
    await this.bucket.take();

    const call = toOneBotCall(action);
    const response = await this.transport.call(call.action, call.params);
    if (response.status === 'failed' || (response.retcode ?? 0) !== 0) {
      const code = response.retcode ?? -1;
      this.emit({ kind: 'send-blocked', code, message: `OneBot 返回失败（retcode=${code}）` });
      throw new Error(`发送失败（retcode=${code}）`);
    }

    const data = (response.data ?? {}) as Record<string, unknown>;
    return { messageId: idToString(data.message_id) || '' };
  }

  getStatus(): AdapterStatus {
    return this.status;
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  onPlatformEvent(handler: (evt: PlatformEvent) => void): void {
    this.platformEventHandler = handler;
  }

  onAdapterEvent(handler: (evt: AdapterEvent) => void): void {
    this.adapterEventHandler = handler;
  }

  private handleEvent(event: OneBotEvent, selfId: string): void {
    if (event.post_type === 'meta_event') {
      // 心跳由客户端自己发 get_status 探测，这里不需要额外处理
      return;
    }

    const ctx = { instanceId: this.deps.instanceId, selfId };
    const message = toInboundMessage(event, ctx);
    if (message) {
      this.messageHandler?.(message);
      return;
    }
    const platformEvent = toPlatformEvent(event, ctx);
    if (platformEvent) {
      this.platformEventHandler?.(platformEvent);
    }
  }

  private emit(event: AdapterEvent): void {
    this.adapterEventHandler?.(event);
  }
}
