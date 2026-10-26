/**
 * 适配器注册表测试：路由键与"找不到就明确报错"。
 * 路由必须按 `platform:protocol`，否则未来 QQ 同时有 onebot 与 official 时会互相覆盖。
 */

import { PLATFORM_CAPABILITIES, type IAdapterFactory } from '@newjob/contracts';
import { describe, expect, it } from 'vitest';

import { AdapterRegistry, adapterKey } from '@/modules/adapter/adapter-registry';

function factory(platform: 'qq' | 'douyin', protocol: 'onebot' | 'douyin-open'): IAdapterFactory {
  return {
    manifest: {
      platform,
      protocol,
      displayName: `${platform}/${protocol}`,
      version: 'test',
      capabilities: PLATFORM_CAPABILITIES[platform],
      // 清单必须能落到 accountId（D041 启动校验），没有它的适配器注册就会失败
      configFields: [
        { key: 'selfId', label: '机器人账号', type: 'text', required: true, mapsTo: 'accountId' },
      ],
    },
    create: () => {
      throw new Error('测试不会真的创建适配器');
    },
  };
}

describe('AdapterRegistry', () => {
  it('routes by platform + protocol', () => {
    const registry = new AdapterRegistry();
    registry.register(factory('qq', 'onebot'));

    expect(registry.has('qq', 'onebot')).toBe(true);
    expect(registry.has('qq', 'official')).toBe(false);
    expect(registry.get('qq', 'onebot').manifest.displayName).toBe('qq/onebot');
  });

  it('keeps two platforms apart even when the protocol name repeats', () => {
    const registry = new AdapterRegistry();
    registry.register(factory('qq', 'onebot'));
    registry.register(factory('douyin', 'douyin-open'));
    expect(registry.list()).toHaveLength(2);
    expect(adapterKey('qq', 'onebot')).not.toBe(adapterKey('douyin', 'douyin-open'));
  });

  it('refuses to silently overwrite an existing adapter', () => {
    const registry = new AdapterRegistry();
    registry.register(factory('qq', 'onebot'));
    expect(() => registry.register(factory('qq', 'onebot'))).toThrow(/重复注册/);
  });

  it('注册时就拒绝不自洽的清单（缺槽位映射）', () => {
    const registry = new AdapterRegistry();
    expect(() =>
      registry.register({
        ...factory('qq', 'onebot'),
        manifest: {
          ...factory('qq', 'onebot').manifest,
          // 有字段但没写 mapsTo：用户填了也无处可存
          configFields: [{ key: 'selfId', label: '账号', type: 'text', required: true }],
        },
      }),
    ).toThrow(/mapsTo/);
  });

  it('注册时就拒绝两个字段抢同一个槽位', () => {
    const registry = new AdapterRegistry();
    expect(() =>
      registry.register({
        ...factory('qq', 'onebot'),
        manifest: {
          ...factory('qq', 'onebot').manifest,
          configFields: [
            { key: 'a', label: 'A', type: 'text', mapsTo: 'accountId' },
            { key: 'b', label: 'B', type: 'text', mapsTo: 'accountId' },
          ],
        },
      }),
    ).toThrow(/一个槽位只能有一个来源/);
  });

  it('fails with a 400 instead of falling back to a default adapter', () => {
    const registry = new AdapterRegistry();
    expect(() => registry.get('qq', 'official')).toThrowError(/没有注册适配器/);
    try {
      registry.get('qq', 'official');
    } catch (err) {
      expect((err as { code: string }).code).toBe('ADAPTER_NOT_FOUND');
    }
  });
});
