/**
 * 适配器注册表：**主服务认识平台的唯一入口**。
 *
 * 路由键是 `platform:protocol`，不是单独的 platform。
 * 理由见 D012：同一个 QQ 可能同时存在 onebot（NapCat）与 official（官方 Bot）两种接入，
 * 能力不同、配置字段不同，必须能共存。
 *
 * 注册是**显式**的：没有目录扫描、没有约定式自动发现。
 * 用 import 一眼能看出"这个版本到底支持哪些平台"，而不是靠运行时碰运气。
 */

import { AppError, type AdapterManifest, type AdapterProtocol, type IAdapterFactory, type Platform } from '@newjob/contracts';

import { assertAdapterManifest } from './manifest-config';

export function adapterKey(platform: Platform | string, protocol: AdapterProtocol | string): string {
  return `${platform}:${protocol}`;
}

export class AdapterRegistry {
  private readonly factories = new Map<string, IAdapterFactory>();

  register(factory: IAdapterFactory): void {
    const key = adapterKey(factory.manifest.platform, factory.manifest.protocol);
    if (this.factories.has(key)) {
      // 重复注册通常意味着两处 import 了同一个包，后者会静默覆盖前者 —— 直接报错更好查
      throw new Error(`适配器重复注册：${key}`);
    }
    // 清单自洽性在**注册时**校验（D041）：字段没地方存、两个字段抢同一个槽位、
    // select 的选项与槽位语义不符 —— 这些都不该等到用户点"创建"才暴露
    assertAdapterManifest(factory.manifest);
    this.factories.set(key, factory);
  }

  /** 找不到时抛 `ADAPTER_NOT_FOUND`（与 `get` 同一套错误语义），供"配置翻译"这类只读场景使用 */
  tryFind(platform: string | undefined, protocol: string | undefined): AdapterManifest | null {
    return this.factories.get(adapterKey(platform ?? '', protocol ?? ''))?.manifest ?? null;
  }

  /** 找不到就抛 `ADAPTER_NOT_FOUND`，不要回退到"默认适配器" */
  get(platform: string, protocol: string): IAdapterFactory {
    const factory = this.factories.get(adapterKey(platform, protocol));
    if (!factory) {
      throw new AppError(
        'ADAPTER_NOT_FOUND',
        `没有注册适配器：${platform}/${protocol}`,
        400,
      );
    }
    return factory;
  }

  has(platform: string, protocol: string): boolean {
    return this.factories.has(adapterKey(platform, protocol));
  }

  /** 前端据此渲染"新建实例"时可选接入方式，不需要改前端代码 */
  list(): AdapterManifest[] {
    return [...this.factories.values()].map((factory) => factory.manifest);
  }
}
