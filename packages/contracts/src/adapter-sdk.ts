/**
 * 适配器开发 SDK —— 平台扩展的唯一入口。
 *
 * 设计目标：抖音、B站等平台作为**独立子项目**开发，不碰主服务一行代码。
 *
 * 一个平台适配器需要做的全部事情：
 *   1. 依赖本包 `@newjob/contracts`
 *   2. 导出一个 `IAdapterFactory`（含 manifest + create）
 *   3. 在主服务的 package.json 里加一行依赖
 *
 * 之后前端会自动渲染配置表单（读 manifest.configFields），
 * 看板会自动展示指标（读 manifest.metrics），主服务会自动按 protocol 路由。
 *
 * 禁止事项：适配器包不允许依赖 `@newjob/core`，不允许直接读写数据库，
 * 不允许自己实现重试/限流/记账 —— 那些是主服务的职责。
 */

import type { IAdapter, AdapterProtocol } from './adapter';
import type { Platform } from './message';
import type { PlatformCapabilities } from './platform';

/**
 * 配置字段描述。前端据此动态渲染表单，**新增平台不需要改前端代码**。
 * 所有 `secret: true` 的字段由主服务用该用户的 DEK 加密存储，且永不回显。
 */
export interface ConfigField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'switch' | 'select' | 'textarea';
  required?: boolean;
  placeholder?: string;
  help?: string;
  default?: string | number | boolean;
  options?: Array<{ label: string; value: string }>;
  /** true = 敏感值，加密存储、界面只显示掩码 */
  secret?: boolean;
}

/** 该平台特有的看板指标。通用指标（消息量、token、成本）由主服务统一提供 */
export interface MetricDescriptor {
  key: string;
  label: string;
  unit?: string;
  /** adapter = 适配器自己统计上报；api = 主服务定时调平台接口拉取 */
  source: 'adapter' | 'api';
}

/**
 * 适配器清单。
 * 主服务与前端都只依赖这个结构，不依赖任何具体实现。
 */
export interface AdapterManifest {
  platform: Platform;
  protocol: AdapterProtocol;
  /** 界面展示名，如「QQ（OneBot 协议）」 */
  displayName: string;
  description?: string;
  version: string;
  capabilities: PlatformCapabilities;
  configFields: ConfigField[];
  metrics?: MetricDescriptor[];
}

/**
 * 主服务注入给适配器的依赖。
 * 适配器**不能**自己去取配置、读数据库、拿 DEK —— 全部由主服务准备好后传入。
 */
export interface AdapterDeps {
  instanceId: string;
  /** 已解密并校验过的配置值，只在内存中存活 */
  config: Record<string, unknown>;
  /**
   * 反向模式的对端 token 校验器，由**主服务**注入。
   *
   * 为什么不是让适配器自己比对明文：
   *   反向监听发生在服务启动时，那时用户还没登录、DEK 不在内存里，
   *   拿不到 token 明文。主服务手里有一份 HMAC 摘要（见 `token-digest.ts`），
   *   足以回答"这个 token 对不对"。
   * 边界：适配器负责"怎么比"（握手时调用），主服务负责"什么算对"（算法与密钥）。
   */
  verifyPeerToken?: (provided: string) => boolean;
  logger: {
    debug(obj: Record<string, unknown>, msg?: string): void;
    info(obj: Record<string, unknown>, msg?: string): void;
    warn(obj: Record<string, unknown>, msg?: string): void;
    error(obj: Record<string, unknown>, msg?: string): void;
  };
}

export interface IAdapterFactory {
  readonly manifest: AdapterManifest;
  create(deps: AdapterDeps): IAdapter;
}

/** 仅用于类型推断，返回原对象 */
export function defineAdapter(factory: IAdapterFactory): IAdapterFactory {
  return factory;
}
