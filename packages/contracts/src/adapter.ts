/**
 * 接入层契约。
 *
 * 实现方：
 *   modules/adapter/onebot    —— QQ（NapCat / OneBot 11 WS 反向连接），已规划
 *   modules/adapter/official  —— QQ 官方 Bot 通道（预留，见 D001）
 *   modules/adapter/douyin    —— 抖音（未实现，预留）
 *   modules/adapter/bilibili  —— B站（未实现，预留）
 *
 * 上层（pipeline）只依赖这个接口，不认识任何具体平台。
 *
 * 关键设计：platform（哪个平台）与 protocol（用哪种协议接入同一个平台）是分开的。
 * 同一个 QQ 可能有 onebot 和 official 两种实现，能力不同，所以 capabilities 挂在实例上而不是平台上。
 */

import type { InboundMessage, OutboundAction, Platform, PlatformEvent } from './message';
import type { PlatformCapabilities } from './platform';

export type AdapterStatus = 'offline' | 'connecting' | 'online' | 'risk';

/** 接入协议。新增平台时追加字面量 */
export type AdapterProtocol = 'onebot' | 'official' | 'douyin-open' | 'bili-open';

/** 连接与风控层面的适配器事件（不含业务事件） */
export type AdapterEvent =
  | { kind: 'status'; status: AdapterStatus }
  /** 发送被平台拦截（风控信号），由 risk.worker 决定降级策略，见 D008 */
  | { kind: 'send-blocked'; code: number; message: string }
  | { kind: 'error'; message: string };

export interface IAdapter {
  readonly platform: Platform;
  readonly protocol: AdapterProtocol;

  /**
   * 该接入方式的能力声明。上层用这个做决策，不要判断 platform 字符串。
   * 例：capabilities.publicReply === true 时，输出审核必须走严格档。
   */
  readonly capabilities: PlatformCapabilities;

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  send(action: OutboundAction): Promise<{ messageId: string }>;

  getStatus(): AdapterStatus;

  /** 订阅入站消息。一个实例只允许一个订阅者（pipeline 入口） */
  onMessage(handler: (msg: InboundMessage) => void): void;

  /** 订阅业务事件（进场、礼物、关注等）。平台不支持则永不触发 */
  onPlatformEvent(handler: (evt: PlatformEvent) => void): void;

  /** 订阅连接与风控事件 */
  onAdapterEvent(handler: (evt: AdapterEvent) => void): void;
}
