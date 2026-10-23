/**
 * OneBot 11 适配器实现骨架。
 *
 * 状态：**未实现**（M1 阶段填充）。
 * 现在保留完整签名，是为了让「把适配器拆成独立包」这件事今天就能验证：
 * 只要结构对，后面填实现不影响主服务。
 *
 * 实现顺序（见 docs/STATUS.md 的 M1）：
 *   1. connect()  —— 建立 WS 反向连接，带 accessToken
 *   2. onMessage  —— 把 OneBot 事件转成 InboundMessage（禁止把原始结构往上抛）
 *   3. send()     —— OutboundAction → OneBot API 调用
 *   4. 心跳与重连 —— 指数退避，连续失败 10 次停止并上报告警
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

export class OneBotAdapter implements IAdapter {
  readonly platform: 'qq' = 'qq';
  readonly protocol: 'onebot' = 'onebot';
  readonly capabilities = manifest.capabilities;

  private status: AdapterStatus = 'offline';
  private messageHandler: ((msg: InboundMessage) => void) | null = null;
  private platformEventHandler: ((evt: PlatformEvent) => void) | null = null;
  private adapterEventHandler: ((evt: AdapterEvent) => void) | null = null;

  constructor(private readonly deps: AdapterDeps) {}

  async connect(): Promise<void> {
    this.deps.logger.warn({ instanceId: this.deps.instanceId }, 'OneBotAdapter 尚未实现');
    throw new Error('OneBotAdapter.connect 尚未实现（M1）');
  }

  async disconnect(): Promise<void> {
    this.status = 'offline';
  }

  async send(_action: OutboundAction): Promise<{ messageId: string }> {
    throw new Error('OneBotAdapter.send 尚未实现（M1）');
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
}
