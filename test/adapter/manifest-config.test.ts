/**
 * 适配器清单 → 实例列的翻译层（D041）。
 *
 * 这层最值钱的地方不是"能翻译"，而是**清单写错时启动就失败**：
 * 一个字段没有 `mapsTo`、两个字段抢同一个槽位、select 的选项与槽位语义不符 ——
 * 这些如果留到用户点"创建"才暴露，表现会是"填了没生效"或一句毫不相干的 zod 报错。
 */

import { PLATFORM_CAPABILITIES, type AdapterManifest, type ConfigField } from '@newjob/contracts';
import { describe, expect, it } from 'vitest';

import {
  assertAdapterManifest,
  requiredFieldKeys,
  translateAdapterConfig,
} from '@/modules/adapter/manifest-config';

/** 一份"像 QQ 那样"的清单：四个字段刚好铺满四个槽位 */
function manifest(overrides: Partial<AdapterManifest> = {}): AdapterManifest {
  return {
    platform: 'qq',
    protocol: 'onebot',
    displayName: 'QQ（OneBot 11）',
    version: 'test',
    capabilities: PLATFORM_CAPABILITIES.qq,
    configFields: [
      {
        key: 'mode',
        label: '接入方向',
        type: 'select',
        required: true,
        default: 'server',
        mapsTo: 'adapterMode',
        options: [
          { label: '反向', value: 'server' },
          { label: '正向', value: 'client' },
        ],
      },
      { key: 'wsUrl', label: 'WebSocket 地址', type: 'text', required: true, mapsTo: 'endpoint' },
      {
        key: 'accessToken',
        label: 'Access Token',
        type: 'password',
        secret: true,
        requiredWhen: { field: 'mode', in: ['server'] },
        mapsTo: 'accessToken',
      },
      { key: 'selfId', label: '机器人 QQ 号', type: 'text', required: true, mapsTo: 'accountId' },
    ],
    ...overrides,
  };
}

/** 常用的一组合法值 */
const VALUES = {
  mode: 'server',
  wsUrl: 'ws://127.0.0.1:3002',
  accessToken: 'napcat-token',
  selfId: '10001',
};

function withFields(fields: ConfigField[]): AdapterManifest {
  return manifest({ configFields: fields });
}

describe('assertAdapterManifest：清单自洽性', () => {
  it('四个槽位铺满的清单通过', () => {
    expect(() => assertAdapterManifest(manifest())).not.toThrow();
  });

  it('字段没写 mapsTo → 拒绝（填了也没地方存）', () => {
    expect(() =>
      assertAdapterManifest(
        withFields([{ key: 'selfId', label: '账号', type: 'text', required: true }]),
      ),
    ).toThrow(/mapsTo/);
  });

  it('两个字段抢同一个槽位 → 拒绝', () => {
    expect(() =>
      assertAdapterManifest(
        withFields([
          { key: 'selfId', label: '账号', type: 'text', mapsTo: 'accountId' },
          { key: 'uid', label: '另一个账号', type: 'text', mapsTo: 'accountId' },
        ]),
      ),
    ).toThrow(/一个槽位只能有一个来源/);
  });

  it('没有任何字段映射到 accountId → 拒绝（连接时不知道用哪个号）', () => {
    expect(() =>
      assertAdapterManifest(
        withFields([{ key: 'wsUrl', label: '地址', type: 'text', mapsTo: 'endpoint' }]),
      ),
    ).toThrow(/accountId/);
  });

  it('secret 却用 text 输入框 → 拒绝（前端会把明文显示出来）', () => {
    expect(() =>
      assertAdapterManifest(
        withFields([
          { key: 'selfId', label: '账号', type: 'text', mapsTo: 'accountId' },
          { key: 'token', label: 'Token', type: 'text', secret: true, mapsTo: 'accessToken' },
        ]),
      ),
    ).toThrow(/secret/);
  });

  it('select 没有 options → 拒绝', () => {
    expect(() =>
      assertAdapterManifest(
        withFields([
          { key: 'selfId', label: '账号', type: 'text', mapsTo: 'accountId' },
          { key: 'mode', label: '方向', type: 'select', mapsTo: 'adapterMode' },
        ]),
      ),
    ).toThrow(/options/);
  });

  it('select 默认值不在 options 里 → 拒绝', () => {
    expect(() =>
      assertAdapterManifest(
        withFields([
          { key: 'selfId', label: '账号', type: 'text', mapsTo: 'accountId' },
          {
            key: 'mode',
            label: '方向',
            type: 'select',
            default: 'reverse',
            mapsTo: 'adapterMode',
            options: [{ label: '反向', value: 'server' }],
          },
        ]),
      ),
    ).toThrow(/默认值/);
  });

  it('映射到 adapterMode 却写了非法方向 → 拒绝（实例表只认 client/server）', () => {
    expect(() =>
      assertAdapterManifest(
        withFields([
          { key: 'selfId', label: '账号', type: 'text', mapsTo: 'accountId' },
          {
            key: 'mode',
            label: '方向',
            type: 'select',
            mapsTo: 'adapterMode',
            options: [{ label: '反向', value: 'reverse' }],
          },
        ]),
      ),
    ).toThrow(/adapterMode/);
  });

  it('requiredWhen 指向不存在的字段 → 拒绝（那条条件永远不会触发）', () => {
    expect(() =>
      assertAdapterManifest(
        withFields([
          { key: 'selfId', label: '账号', type: 'text', mapsTo: 'accountId' },
          {
            key: 'token',
            label: 'Token',
            type: 'password',
            secret: true,
            mapsTo: 'accessToken',
            requiredWhen: { field: 'nope', in: ['server'] },
          },
        ]),
      ),
    ).toThrow(/requiredWhen/);
  });

  it('重复的 key → 拒绝', () => {
    expect(() =>
      assertAdapterManifest(
        withFields([
          { key: 'selfId', label: '账号', type: 'text', mapsTo: 'accountId' },
          { key: 'selfId', label: '地址', type: 'text', mapsTo: 'endpoint' },
        ]),
      ),
    ).toThrow(/重复/);
  });
});

describe('requiredFieldKeys：必填随当前值变化', () => {
  it('反向模式要求 token，正向不要求', () => {
    expect(requiredFieldKeys(manifest(), { mode: 'server' })).toContain('accessToken');
    expect(requiredFieldKeys(manifest(), { mode: 'client' })).not.toContain('accessToken');
  });

  it('缺省也算反向（清单默认值是 server）', () => {
    // 表单刚打开、还没选过方向时，条件字段应当按默认值判
    expect(requiredFieldKeys(manifest(), { mode: 'server' })).toEqual(
      expect.arrayContaining(['accessToken', 'selfId', 'wsUrl', 'mode']),
    );
  });
});

describe('translateAdapterConfig：创建（完整）', () => {
  it('翻译成四个实例槽位', () => {
    expect(translateAdapterConfig({ manifest: manifest(), values: VALUES })).toEqual({
      adapterMode: 'server',
      endpoint: 'ws://127.0.0.1:3002',
      accessToken: 'napcat-token',
      accountId: '10001',
    });
  });

  it('必填缺失 → 400 且报中文字段名（不是 key）', () => {
    const { selfId, ...rest } = VALUES;
    void selfId;
    expect(() => translateAdapterConfig({ manifest: manifest(), values: rest })).toThrow(
      /机器人 QQ 号/,
    );
  });

  it('条件必填生效：反向模式没 token → 400', () => {
    const { accessToken, ...rest } = VALUES;
    void accessToken;
    expect(() => translateAdapterConfig({ manifest: manifest(), values: rest })).toThrow(
      /Access Token/,
    );
  });

  it('正向模式没 token → 通过（可选字段留空就是没填）', () => {
    const result = translateAdapterConfig({
      manifest: manifest(),
      values: { ...VALUES, mode: 'client', accessToken: '' },
    });
    expect(result.adapterMode).toBe('client');
    expect(result.accessToken).toBeUndefined();
  });

  it('未知字段 → 400（前端拿旧清单或拼错，静默忽略就是"填了没生效"）', () => {
    expect(() =>
      translateAdapterConfig({ manifest: manifest(), values: { ...VALUES, wssUrl: 'x' } }),
    ).toThrow(/未知字段/);
  });

  it('select 写了清单外的值 → 400 并列出可选值', () => {
    expect(() =>
      translateAdapterConfig({ manifest: manifest(), values: { ...VALUES, mode: 'reverse' } }),
    ).toThrow(/server \/ client/);
  });

  it('number 字段会校验是不是数字', () => {
    const m = withFields([
      { key: 'selfId', label: '账号', type: 'text', mapsTo: 'accountId' },
      { key: 'port', label: '端口', type: 'number', mapsTo: 'endpoint' },
    ]);
    expect(translateAdapterConfig({ manifest: m, values: { selfId: '1', port: '3002' } })).toEqual({
      accountId: '1',
      endpoint: '3002',
    });
    expect(() => translateAdapterConfig({ manifest: m, values: { selfId: '1', port: 'abc' } })).toThrow(
      /数字/,
    );
  });

  it('文本会 trim，纯空白算没填', () => {
    expect(
      translateAdapterConfig({ manifest: manifest(), values: { ...VALUES, selfId: '  10001  ' } })
        .accountId,
    ).toBe('10001');
    expect(() =>
      translateAdapterConfig({ manifest: manifest(), values: { ...VALUES, selfId: '   ' } }),
    ).toThrow(/机器人 QQ 号/);
  });
});

describe('translateAdapterConfig：更新（增量）', () => {
  it('没传的字段不出现（否则每次都写一遍接入参数，会触发多余重连）', () => {
    expect(
      translateAdapterConfig({ manifest: manifest(), values: { selfId: '20002' }, partial: true }),
    ).toEqual({ accountId: '20002' });
  });

  it('全空对象就是"什么都不改"', () => {
    expect(translateAdapterConfig({ manifest: manifest(), values: {}, partial: true })).toEqual({});
  });

  it('但把必填项改成空 → 仍然 400（不允许把实例改成连不上）', () => {
    expect(() =>
      translateAdapterConfig({ manifest: manifest(), values: { selfId: '' }, partial: true }),
    ).toThrow(/机器人 QQ 号/);
  });
});
