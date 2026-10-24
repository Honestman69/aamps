/**
 * 实例服务测试。
 *
 * 这里验证的是"能不能真的把某个 QQ 号接上"中间那段**业务逻辑**：
 *   token 解密 → 配置映射 → 适配器创建 → 接线 → pong 回声 → 状态落库。
 * 网络协议本身由 `test/adapter-qq/onebot-e2e.test.ts` 用真实 WS 服务端覆盖，
 * 所以这里用桩适配器，测试跑得快且失败点清晰。
 */

import { KeyLockedError, PLATFORM_CAPABILITIES } from '@newjob/contracts';
import type {
  AdapterDeps,
  AdapterStatus,
  IAdapter,
  InboundMessage,
  OutboundAction,
  PlatformEvent,
} from '@newjob/contracts';
import { describe, expect, it } from 'vitest';

import { decryptWithDek, encryptWithDek, randomDek } from '@/common/crypto';
import { AdapterRegistry } from '@/modules/adapter/adapter-registry';
import { AuditService } from '@/modules/auth/audit.service';
import { RuntimeKeyStore } from '@/modules/auth/runtime-key-store';
import { InstanceRuntime } from '@/modules/instance/instance-runtime';
import { InstanceService, maskAccount, type InstanceActor } from '@/modules/instance/instance.service';
import type {
  IInstanceRepository,
  InstanceConnectConfig,
  InstanceCreateInput,
  InstancePublicRow,
  InstanceUpdatePatch,
} from '@/modules/instance/ports';

import { FakeAuditRepository } from '../helpers/auth-fakes';

const TENANT = 'tenant-1';
const ALICE = 'user-alice';
const BOB = 'user-bob';
const SESSION_ALICE = 'session-alice';
const SESSION_BOB = 'session-bob';
const TOKEN = 'napcat-token-abc';

class StubAdapter implements IAdapter {
  readonly platform = 'qq' as const;
  readonly protocol = 'onebot' as const;
  readonly capabilities = PLATFORM_CAPABILITIES.qq;

  status: AdapterStatus = 'offline';
  sent: OutboundAction[] = [];
  connectCalls = 0;
  failConnect = false;
  messageHandler: ((msg: InboundMessage) => void) | null = null;

  constructor(readonly deps: AdapterDeps) {}

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.failConnect) {
      throw new Error('NapCat 未启动');
    }
    this.status = 'online';
  }

  async disconnect(): Promise<void> {
    this.status = 'offline';
  }

  async send(action: OutboundAction): Promise<{ messageId: string }> {
    this.sent.push(action);
    return { messageId: 'sent-1' };
  }

  getStatus(): AdapterStatus {
    return this.status;
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  onPlatformEvent(_handler: (evt: PlatformEvent) => void): void {
    // 测试不关心平台事件
  }

  onAdapterEvent(): void {
    // 测试不关心连接事件
  }
}

class FakeInstanceRepository implements IInstanceRepository {
  readonly rows = new Map<string, { row: InstancePublicRow; enc: string | null; ownerUserId: string }>();
  readonly created: InstanceCreateInput[] = [];
  private seq = 0;

  async createForUser(input: InstanceCreateInput): Promise<InstancePublicRow> {
    this.created.push({ ...input });
    this.seq += 1;
    const now = new Date();
    const row: InstancePublicRow = {
      id: `inst-${this.seq}`,
      name: input.name,
      platform: input.platform,
      accountId: input.accountId,
      adapterType: input.adapterType,
      endpoint: input.endpoint ?? null,
      hasAccessToken: Boolean(input.accessTokenEnc),
      enabled: input.enabled ?? true,
      status: 'offline',
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, { row, enc: input.accessTokenEnc ?? null, ownerUserId: input.ownerUserId });
    return { ...row };
  }

  async listForUser(userId: string): Promise<InstancePublicRow[]> {
    return [...this.rows.values()]
      .filter((entry) => entry.ownerUserId === userId)
      .map((entry) => ({ ...entry.row }));
  }

  async findForUser(userId: string, id: string): Promise<InstancePublicRow | null> {
    const entry = this.rows.get(id);
    return entry && entry.ownerUserId === userId ? { ...entry.row } : null;
  }

  async findForConnect(userId: string, id: string): Promise<InstanceConnectConfig | null> {
    const entry = this.rows.get(id);
    if (!entry || entry.ownerUserId !== userId) {
      return null;
    }
    return {
      id: entry.row.id,
      platform: entry.row.platform,
      adapterType: entry.row.adapterType,
      accountId: entry.row.accountId,
      endpoint: entry.row.endpoint,
      accessTokenEnc: entry.enc,
      enabled: entry.row.enabled,
    };
  }

  async updateForUser(
    userId: string,
    id: string,
    patch: InstanceUpdatePatch,
  ): Promise<InstancePublicRow | null> {
    const entry = this.rows.get(id);
    if (!entry || entry.ownerUserId !== userId) {
      return null;
    }
    if (patch.accessTokenEnc !== undefined) {
      entry.enc = patch.accessTokenEnc;
      entry.row.hasAccessToken = Boolean(patch.accessTokenEnc);
    }
    const { accessTokenEnc: _ignored, ...rest } = patch;
    Object.assign(entry.row, rest);
    return { ...entry.row };
  }

  async deleteForUser(userId: string, id: string): Promise<boolean> {
    const entry = this.rows.get(id);
    if (!entry || entry.ownerUserId !== userId) {
      return false;
    }
    this.rows.delete(id);
    return true;
  }

  async setStatusForUser(userId: string, id: string, status: string): Promise<boolean> {
    const entry = this.rows.get(id);
    if (!entry || entry.ownerUserId !== userId) {
      return false;
    }
    entry.row.status = status;
    return true;
  }

  async countForUser(userId: string): Promise<number> {
    return [...this.rows.values()].filter((entry) => entry.ownerUserId === userId).length;
  }
}

function actor(userId: string, role = 'user'): InstanceActor {
  return {
    sessionId: userId === ALICE ? SESSION_ALICE : SESSION_BOB,
    userId,
    tenantId: TENANT,
    role,
    ip: '127.0.0.1',
  };
}

function setup(options: { failConnect?: boolean } = {}) {
  const repo = new FakeInstanceRepository();
  const auditRepo = new FakeAuditRepository();
  const keyStore = new RuntimeKeyStore();
  const registry = new AdapterRegistry();
  const created: StubAdapter[] = [];
  registry.register({
    manifest: {
      platform: 'qq',
      protocol: 'onebot',
      displayName: 'QQ（OneBot 11）',
      version: 'test',
      capabilities: PLATFORM_CAPABILITIES.qq,
      configFields: [],
    },
    create: (deps) => {
      const adapter = new StubAdapter(deps);
      adapter.failConnect = options.failConnect ?? false;
      created.push(adapter);
      return adapter;
    },
  });

  const runtime = new InstanceRuntime();
  const service = new InstanceService({
    instances: repo,
    keyStore,
    registry,
    runtime,
    audit: new AuditService(auditRepo),
  });

  return { repo, auditRepo, keyStore, registry, runtime, service, created };
}

describe('InstanceService 配置与隔离', () => {
  it('encrypts the NapCat token with the owner DEK and never returns it', async () => {
    const { repo, keyStore, service } = setup();
    const dek = randomDek();
    keyStore.set(SESSION_ALICE, ALICE, dek);

    const dto = await service.create(actor(ALICE), {
      name: '主号',
      accountId: '10001',
      endpoint: 'ws://127.0.0.1:6700/onebot/v11/ws',
      accessToken: TOKEN,
    });

    const stored = repo.created[0]!;
    expect(stored.accessTokenEnc?.startsWith('dek:v1:')).toBe(true);
    expect(stored.accessTokenEnc).not.toContain(TOKEN);
    expect(decryptWithDek(stored.accessTokenEnc!, dek)).toBe(TOKEN);

    expect(dto.hasAccessToken).toBe(true);
    expect(dto).not.toHaveProperty('accessTokenEnc');
    expect(dto).not.toHaveProperty('ownerUserId');
    expect(dto.accountId).toBe('10001');
  });

  it('does not require an unlocked vault when no token is configured', async () => {
    const { service } = setup();
    const dto = await service.create(actor(ALICE), {
      name: '内网无鉴权',
      accountId: '10002',
      endpoint: 'ws://127.0.0.1:6700/onebot/v11/ws',
    });
    expect(dto.hasAccessToken).toBe(false);
  });

  it("lists only the caller's instances and reports live status", async () => {
    const { keyStore, service } = setup();
    keyStore.set(SESSION_ALICE, ALICE, randomDek());
    keyStore.set(SESSION_BOB, BOB, randomDek());

    await service.create(actor(ALICE), { name: 'A 的号', accountId: '10001' });
    await service.create(actor(BOB), { name: 'B 的号', accountId: '20002' });

    const aliceList = await service.list({ userId: ALICE });
    expect(aliceList).toHaveLength(1);
    expect(aliceList[0]!.name).toBe('A 的号');
    // 没连上时不能显示库里残留的旧状态
    expect(aliceList[0]!.status).toBe('offline');
  });

  it('refuses to store a public endpoint unless the switch is on', async () => {
    const { service } = setup();

    await expect(
      service.create(actor(ALICE), {
        name: '别人的 NapCat',
        accountId: '10001',
        endpoint: 'ws://bot.example.com:3001',
      }),
    ).rejects.toMatchObject({ code: 'REMOTE_ENDPOINT_BLOCKED' });

    process.env.ALLOW_REMOTE_ADAPTER = 'true';
    try {
      const dto = await service.create(actor(ALICE), {
        name: '明确接受风险的远程实例',
        accountId: '10001',
        endpoint: 'ws://bot.example.com:3001',
      });
      expect(dto.endpoint).toBe('ws://bot.example.com:3001');
    } finally {
      delete process.env.ALLOW_REMOTE_ADAPTER;
    }
  });

  it('instances of another user are not reachable even for superadmin', async () => {
    const { keyStore, service } = setup();
    keyStore.set(SESSION_BOB, BOB, randomDek());

    const bobInstance = await service.create(actor(BOB), { name: 'B 的号', accountId: '20002' });
    const superadmin = actor(ALICE, 'superadmin');

    await expect(service.connect(superadmin, bobInstance.id)).rejects.toMatchObject({
      code: 'INSTANCE_NOT_FOUND',
    });
    await expect(service.update(superadmin, bobInstance.id, { name: '偷改' })).rejects.toMatchObject({
      code: 'INSTANCE_NOT_FOUND',
    });
    await expect(service.remove(superadmin, bobInstance.id)).rejects.toMatchObject({
      code: 'INSTANCE_NOT_FOUND',
    });
  });
});

describe('InstanceService 连接链路', () => {
  it('refuses to connect before the vault is unlocked', async () => {
    const { keyStore, service } = setup();
    keyStore.set(SESSION_ALICE, ALICE, randomDek());
    const dto = await service.create(actor(ALICE), {
      name: '主号',
      accountId: '10001',
      endpoint: 'ws://127.0.0.1:6700/onebot/v11/ws',
      accessToken: TOKEN,
    });
    // 模拟进程重启：会话还在，DEK 已经没了
    keyStore.clear(SESSION_ALICE);

    await expect(service.connect(actor(ALICE), dto.id)).rejects.toBeInstanceOf(KeyLockedError);
  });

  it('maps the stored columns into adapter config and echoes pong to inbound messages', async () => {
    const { keyStore, service, runtime, created, repo, auditRepo } = setup();
    const dek = randomDek();
    keyStore.set(SESSION_ALICE, ALICE, dek);

    const dto = await service.create(actor(ALICE), {
      name: '主号',
      accountId: '10001',
      endpoint: 'ws://127.0.0.1:6700/onebot/v11/ws',
      accessToken: TOKEN,
    });

    const result = await service.connect(actor(ALICE), dto.id);
    expect(result).toMatchObject({ status: 'online', accountId: '10001', platform: 'qq' });

    const adapter = created[0]!;
    // 列名 → 适配器配置字段名，且 token 是解密后的明文
    expect(adapter.deps.config).toEqual({
      wsUrl: 'ws://127.0.0.1:6700/onebot/v11/ws',
      selfId: '10001',
      accessToken: TOKEN,
    });
    expect(runtime.get(dto.id)).toBe(adapter);
    expect(repo.rows.get(dto.id)!.row.status).toBe('online');
    expect(auditRepo.rows.at(-1)!.action).toBe('instance.connect');
    // 审计里不能有完整 QQ 号与 token
    expect(auditRepo.rows.at(-1)!.afterJson).not.toContain('10001');
    expect(auditRepo.rows.at(-1)!.afterJson).not.toContain(TOKEN);

    adapter.messageHandler?.({
      id: 'msg-1',
      platform: 'qq',
      instanceId: dto.id,
      session: { kind: 'private', peerId: '20002' },
      sender: { id: '20002', name: '小明', isOwner: false },
      segments: [{ type: 'text', text: 'ping' }],
      plainText: 'ping',
      isMentioned: true,
      receivedAt: new Date(),
    });

    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]).toMatchObject({
      kind: 'send',
      segments: [{ type: 'text', text: 'pong' }],
      replyToMessageId: 'msg-1',
    });
  });

  it('reports a clear error when NapCat is unreachable and leaves no runtime behind', async () => {
    const { keyStore, service, runtime } = setup({ failConnect: true });
    keyStore.set(SESSION_ALICE, ALICE, randomDek());

    const dto = await service.create(actor(ALICE), {
      name: '主号',
      accountId: '10001',
      endpoint: 'ws://127.0.0.1:6700/onebot/v11/ws',
    });

    await expect(service.connect(actor(ALICE), dto.id)).rejects.toMatchObject({
      code: 'INSTANCE_CONNECT_FAILED',
    });
    // 失败不能留半个连接在运行时里
    expect(runtime.get(dto.id)).toBeNull();
  });

  it('disconnects automatically when the endpoint changes', async () => {
    const { keyStore, service, runtime } = setup();
    keyStore.set(SESSION_ALICE, ALICE, randomDek());

    const dto = await service.create(actor(ALICE), {
      name: '主号',
      accountId: '10001',
      endpoint: 'ws://127.0.0.1:6700/onebot/v11/ws',
    });
    await service.connect(actor(ALICE), dto.id);
    expect(runtime.get(dto.id)).not.toBeNull();

    const updated = await service.update(actor(ALICE), dto.id, {
      endpoint: 'ws://10.0.0.2:6700/onebot/v11/ws',
    });

    expect(updated.status).toBe('offline');
    expect(runtime.get(dto.id)).toBeNull();
  });

  it('stops the adapter before deleting the row', async () => {
    const { keyStore, service, runtime } = setup();
    keyStore.set(SESSION_ALICE, ALICE, randomDek());

    const dto = await service.create(actor(ALICE), {
      name: '主号',
      accountId: '10001',
      endpoint: 'ws://127.0.0.1:6700/onebot/v11/ws',
    });
    await service.connect(actor(ALICE), dto.id);

    await service.remove(actor(ALICE), dto.id);
    expect(runtime.get(dto.id)).toBeNull();
  });
});

describe('maskAccount', () => {
  it('keeps only the first and last two digits', () => {
    expect(maskAccount('10001')).toBe('10****01');
    expect(maskAccount('123456789')).toBe('12****89');
  });

  it('masks very short identifiers entirely', () => {
    expect(maskAccount('1234')).toBe('****');
  });
});
