/**
 * 实例仓储的「字段契约」测试。
 *
 * 为什么需要它：`createForUser` 是手写 `data: {...}` 的，**漏一个字段不会报错**，
 * Prisma 会安静地用数据库默认值补上。`adapterMode` 就这么漏过：库里默认是 `client`，
 * 而产品默认是 `server`，于是"传了 server 却建出 client"，单测用的是假仓储所以全绿，
 * 端到端冒烟才抓到。
 *
 * 这里不连库，只断言 Prisma 收到的参数：漏字段、漏 select 都会当场失败。
 */

import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import type { InstanceCreateInput } from '@/modules/instance/ports';
import { PrismaInstanceRepository } from '@/modules/instance/repositories/prisma-instance.repository';

type Call = { method: string; args: Record<string, unknown> };

const ROW = {
  id: 'inst-1',
  agentId: 'agent-1',
  name: '主号',
  platform: 'qq',
  accountId: '10001',
  adapterType: 'onebot',
  adapterMode: 'server',
  endpoint: 'ws://127.0.0.1:3002',
  enabled: true,
  status: 'offline',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  accessTokenEnc: 'v1:xxx',
};

function makePrisma() {
  const calls: Call[] = [];
  const record = (method: string, args: Record<string, unknown>): void => {
    calls.push({ method, args });
  };

  const prisma = {
    botInstance: {
      create: async (args: Record<string, unknown>) => {
        record('create', args);
        return { ...ROW, ...(args.data as Record<string, unknown>) };
      },
      findFirst: async (args: Record<string, unknown>) => {
        record('findFirst', args);
        return { ...ROW, ...((args.select as Record<string, unknown>) ?? {}) };
      },
    },
  } as unknown as PrismaClient;

  return { prisma, calls };
}

const INPUT: InstanceCreateInput = {
  tenantId: 'tenant-1',
  ownerUserId: 'user-alice',
  agentId: 'agent-1',
  name: '主号',
  platform: 'qq',
  accountId: '10001',
  adapterType: 'onebot',
  adapterMode: 'server',
  endpoint: 'ws://127.0.0.1:3002',
  accessTokenEnc: 'v1:xxx',
  enabled: true,
};

describe('PrismaInstanceRepository.createForUser', () => {
  it('把每个入参字段都透传给 create（漏字段会静默退回 DB 默认值）', async () => {
    const { prisma, calls } = makePrisma();
    const repo = new PrismaInstanceRepository(prisma);

    await repo.createForUser(INPUT);

    const data = calls.find((call) => call.method === 'create')!.args.data as Record<string, unknown>;
    for (const key of Object.keys(INPUT)) {
      expect(data, `字段 ${key} 没有透传给 create`).toHaveProperty(key);
    }
    // 这一条单独钉住：它就是真出过的 bug（传 server 落成 client）
    expect(data.adapterMode).toBe('server');
  });

  it('读回时把 adapterMode 一起 select 出来', async () => {
    // 漏 select 同样不报错，但 DTO 里会变成 undefined，界面上就是空
    const { prisma, calls } = makePrisma();
    const repo = new PrismaInstanceRepository(prisma);

    const row = await repo.createForUser(INPUT);

    const select = calls.find((call) => call.method === 'create')!.args.select as Record<
      string,
      unknown
    >;
    expect(select.adapterMode).toBe(true);
    expect(row.adapterMode).toBe('server');
  });
});

describe('PrismaInstanceRepository.findForConnect', () => {
  it('连接用的字段集里必须带 adapterMode', async () => {
    // 少了它，适配器就拿不到方向，只能按解析默认值走（与实例配置不一致）
    const { prisma, calls } = makePrisma();
    const repo = new PrismaInstanceRepository(prisma);

    await repo.findForConnect('user-alice', 'inst-1');

    const call = calls.find((item) => item.method === 'findFirst')!;
    const select = call.args.select as Record<string, unknown>;
    expect(select.adapterMode).toBe(true);
    expect(select.accessTokenEnc).toBe(true);
    // 归属过滤不能省：拿到别人的 id 也只得到 null
    expect(call.args.where).toMatchObject({ id: 'inst-1', ownerUserId: 'user-alice' });
  });
});
