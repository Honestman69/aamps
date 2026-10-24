/**
 * 实例服务测试。
 *
 * 这里验证的是"能不能真的把某个 QQ 号接上"中间那段**业务逻辑**：
 *   token 解密 → 配置映射 → 适配器创建 → 接线 → pong 回声 → 状态落库。
 * 网络协议本身由 `test/adapter-qq/onebot-e2e.test.ts` 用真实 WS 服务端覆盖，
 * 所以这里用桩适配器，测试跑得快且失败点清晰。
 */

import { KeyLockedError, PLATFORM_CAPABILITIES } from '@newjob/contracts';
import type { IAgentRepository } from '@/modules/agent/ports';
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
  InstanceResidentConfig,
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

class FakeAgentRepository implements IAgentRepository {
  readonly ensured: Array<{ tenantId: string; ownerUserId: string }> = [];

  async ensureDefaultForUser(tenantId: string, ownerUserId: string): Promise<{ id: string }> {
    this.ensured.push({ tenantId, ownerUserId });
    return { id: 'agent-default' };
  }

  async findForUser(): Promise<null> {
    return null;
  }
}

class FakeInstanceRepository implements IInstanceRepository {
  readonly rows = new Map<
    string,
    { row: InstancePublicRow; enc: string | null; digest: string | null; ownerUserId: string }
  >();
  readonly created: InstanceCreateInput[] = [];
  private seq = 0;

  async createForUser(input: InstanceCreateInput): Promise<InstancePublicRow> {
    this.created.push({ ...input });
    this.seq += 1;
    const now = new Date();
    const row: InstancePublicRow = {
      id: `inst-${this.seq}`,
      agentId: input.agentId,
      name: input.name,
      platform: input.platform,
      accountId: input.accountId,
      adapterType: input.adapterType,
      adapterMode: input.adapterMode ?? 'server',
      endpoint: input.endpoint ?? null,
      hasAccessToken: Boolean(input.accessTokenEnc),
      enabled: input.enabled ?? true,
      status: 'offline',
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, {
      row,
      enc: input.accessTokenEnc ?? null,
      digest: input.accessTokenDigest ?? null,
      ownerUserId: input.ownerUserId,
    });
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
      adapterMode: entry.row.adapterMode,
      accountId: entry.row.accountId,
      endpoint: entry.row.endpoint,
      accessTokenEnc: entry.enc,
      accessTokenDigest: entry.digest,
      enabled: entry.row.enabled,
    };
  }

  async listResidentListenCandidates(): Promise<InstanceResidentConfig[]> {
    return [...this.rows.values()]
      .filter((e) => e.row.enabled && e.row.adapterMode === 'server' && e.digest && e.row.endpoint)
      .map((e) => ({
        id: e.row.id,
        platform: e.row.platform,
        adapterType: e.row.adapterType,
        adapterMode: e.row.adapterMode,
        accountId: e.row.accountId,
        endpoint: e.row.endpoint,
        accessTokenEnc: e.enc,
        accessTokenDigest: e.digest,
        enabled: e.row.enabled,
        ownerUserId: e.ownerUserId,
      }));
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
    if (patch.accessTokenDigest !== undefined) {
      entry.digest = patch.accessTokenDigest;
    }
    const { accessTokenEnc: _ignored, accessTokenDigest: _ignoredDigest, ...rest } = patch;
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
  const agents = new FakeAgentRepository();
  const service = new InstanceService({
    instances: repo,
    agents,
    keyStore,
    registry,
    runtime,
    audit: new AuditService(auditRepo),
  });

  return { repo, agents, auditRepo, keyStore, registry, runtime, service, created };
}

describe('InstanceService 配置与隔离', () => {
  it('创建实例时自动挂到用户的默认 Agent（D020：归属不挂在实例上）', async () => {
    const { repo, agents, service } = setup();

    const dto = await service.create(actor(ALICE), {
      name: '主号',
      accountId: '10001',
      adapterMode: 'client',
    });

    // 只有一个默认 Agent，且被"保证存在"过一次
    expect(agents.ensured).toHaveLength(1);
    expect(agents.ensured[0]?.ownerUserId).toBe(ALICE);
    // agentId 透传到仓储，并且出现在返回体里（前端要能看出这是哪个 AI 的号）
    expect(repo.created[0]?.agentId).toBe('agent-default');
    expect(dto.agentId).toBe('agent-default');
  });

  it('encrypts the NapCat token with the owner DEK and never returns it', async () => {
    const { repo, keyStore, service } = setup();
    const dek = randomDek();
    keyStore.set(SESSION_ALICE, ALICE, dek);

    const dto = await service.create(actor(ALICE), {
      name: '主号',
      accountId: '10001',
      adapterMode: 'client',
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
      adapterMode: 'client',
      endpoint: 'ws://127.0.0.1:6700/onebot/v11/ws',
    });
    expect(dto.hasAccessToken).toBe(false);
  });

  it("lists only the caller's instances and reports live status", async () => {
    const { keyStore, service } = setup();
    keyStore.set(SESSION_ALICE, ALICE, randomDek());
    keyStore.set(SESSION_BOB, BOB, randomDek());

    await service.create(actor(ALICE), { name: 'A 的号', accountId: '10001', adapterMode: 'client' });
    await service.create(actor(BOB), { name: 'B 的号', accountId: '20002', adapterMode: 'client' });

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
        adapterMode: 'client',
        endpoint: 'ws://bot.example.com:3001',
      }),
    ).rejects.toMatchObject({ code: 'REMOTE_ENDPOINT_BLOCKED' });

    process.env.ALLOW_REMOTE_ADAPTER = 'true';
    try {
      const dto = await service.create(actor(ALICE), {
        name: '明确接受风险的远程实例',
        accountId: '10001',
        adapterMode: 'client',
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

    const bobInstance = await service.create(actor(BOB), { name: 'B 的号', accountId: '20002', adapterMode: 'client' });
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
      adapterMode: 'client',
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
      adapterMode: 'client',
      endpoint: 'ws://127.0.0.1:6700/onebot/v11/ws',
      accessToken: TOKEN,
    });

    const result = await service.connect(actor(ALICE), dto.id);
    expect(result).toMatchObject({ status: 'online', accountId: '10001', platform: 'qq' });

    const adapter = created[0]!;
    // 列名 → 适配器配置字段名，且 token 是解密后的明文
    expect(adapter.deps.config).toEqual({
      mode: 'client',
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
    // 占位回声不带引用：真人不会对每句话都点引用（引用由 M3 表达层决定）
    expect(adapter.sent[0]).toMatchObject({
      kind: 'send',
      segments: [{ type: 'text', text: 'pong' }],
    });
    const sent = adapter.sent[0]!;
    expect(sent.kind).toBe('send');
    expect(sent.kind === 'send' ? sent.replyToMessageId : 'unexpected').toBeUndefined();
  });

  it('reports a clear error when NapCat is unreachable and leaves no runtime behind', async () => {
    const { keyStore, service, runtime } = setup({ failConnect: true });
    keyStore.set(SESSION_ALICE, ALICE, randomDek());

    const dto = await service.create(actor(ALICE), {
      name: '主号',
      accountId: '10001',
      adapterMode: 'client',
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
      adapterMode: 'client',
      endpoint: 'ws://127.0.0.1:6700/onebot/v11/ws',
    });
    await service.connect(actor(ALICE), dto.id);
    expect(runtime.get(dto.id)).not.toBeNull();

    const updated = await service.update(actor(ALICE), dto.id, {
      adapterMode: 'client',
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
      adapterMode: 'client',
      endpoint: 'ws://127.0.0.1:6700/onebot/v11/ws',
    });
    await service.connect(actor(ALICE), dto.id);

    await service.remove(actor(ALICE), dto.id);
    expect(runtime.get(dto.id)).toBeNull();
  });
});

describe('反向实例：不需要解锁也能监听（D019）', () => {
  /** 建一个反向实例，然后清掉 DEK —— 模拟服务重启后"没有任何人登录"的状态 */
  async function reverseInstanceWithLockedVault() {
    const ctx = setup();
    const dek = randomDek();
    ctx.keyStore.set(SESSION_ALICE, ALICE, dek);
    const dto = await ctx.service.create(actor(ALICE), {
      name: '反向实例',
      accountId: '10001',
      adapterMode: 'server',
      endpoint: 'ws://127.0.0.1:3002',
      accessToken: TOKEN,
    });
    ctx.keyStore.clear(SESSION_ALICE);
    // 把 DEK 带出来：回填测试要用**同一把**，重新生成一把解不开旧密文
    return { ...ctx, dto, dek };
  }

  it('refuses to create a reverse instance without a token', async () => {
    const { service } = setup();
    await expect(
      service.create(actor(ALICE), {
        name: '没有 token',
        accountId: '10001',
        adapterMode: 'server',
        endpoint: 'ws://127.0.0.1:3002',
      }),
    ).rejects.toThrow(/Access Token/);
  });

  it('connects with the vault locked: the adapter gets a verifier, not the plaintext', async () => {
    const { service, runtime, created, dto } = await reverseInstanceWithLockedVault();

    const result = await service.connect(actor(ALICE), dto.id);

    expect(result.status).toBe('online');
    expect(runtime.get(dto.id)).not.toBeNull();
    // 关键断言：反向路径不要求明文 token，主服务注入的是校验器
    expect(created[0]!.deps.verifyPeerToken).toBeTypeOf('function');
    expect(created[0]!.deps.config.accessToken).toBeUndefined();
    // 校验器真的能区分对错
    expect(created[0]!.deps.verifyPeerToken!(TOKEN)).toBe(true);
    expect(created[0]!.deps.verifyPeerToken!('wrong-token')).toBe(false);
  });

  it('resumes reverse listeners at startup with no session at all', async () => {
    const { service, runtime, repo, dto } = await reverseInstanceWithLockedVault();

    // 重启后没有任何人登录：靠启动钩子自己把监听恢复起来
    const result = await service.resumeResidentListeners();

    expect(result).toMatchObject({ started: 1, failed: 0, skipped: 0 });
    expect(runtime.get(dto.id)?.getStatus()).toBe('online');
    expect(repo.rows.get(dto.id)!.row.status).toBe('online');
  });

  it('skips rows without a digest, then backfills it on the next manual connect', async () => {
    const { service, runtime, repo, keyStore, dto, dek } = await reverseInstanceWithLockedVault();

    // 模拟"加摘要列之前"的老数据：有密文、没有摘要
    repo.rows.get(dto.id)!.digest = null;

    const resumed = await service.resumeResidentListeners();
    // 没有摘要就没有校验手段，宁可不起也不开一个不设防的端口
    expect(resumed).toMatchObject({ started: 0, failed: 0, skipped: 0 });
    expect(runtime.get(dto.id)).toBeNull();

    // 用户解锁后手动连一次：顺手把摘要补上
    keyStore.set(SESSION_ALICE, ALICE, dek);
    await service.connect(actor(ALICE), dto.id);
    expect(repo.rows.get(dto.id)!.digest).toBeTypeOf('string');
  });

  it('clears the digest when the token is cleared', async () => {
    const { keyStore, service, repo } = setup();
    keyStore.set(SESSION_ALICE, ALICE, randomDek());
    const dto = await service.create(actor(ALICE), {
      name: '反向实例',
      accountId: '10001',
      adapterMode: 'server',
      endpoint: 'ws://127.0.0.1:3002',
      accessToken: TOKEN,
    });
    expect(repo.rows.get(dto.id)!.digest).toBeTypeOf('string');

    await service.update(actor(ALICE), dto.id, { accessToken: null });

    // 摘要留着明文没了，会变成"能监听但没人知道 token"的怪状态
    expect(repo.rows.get(dto.id)!.digest).toBeNull();
    expect(repo.rows.get(dto.id)!.enc).toBeNull();
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
