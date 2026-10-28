/**
 * 实例服务测试。
 *
 * 这里验证的是"能不能真的把某个 QQ 号接上"中间那段**业务逻辑**：
 *   token 解密 → 配置映射 → 适配器创建 → 接线 → 转发给 Pipeline → 状态落库。
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
      name: input.name,
      platform: input.platform,
      accountId: input.accountId,
      adapterType: input.adapterType,
      adapterMode: input.adapterMode ?? 'server',
      endpoint: input.endpoint ?? null,
      hasAccessToken: Boolean(input.accessTokenEnc),
      modelVision: input.modelVision ?? null,
      ttsCredentialId: input.ttsCredentialId ?? null,
      ttsModel: input.ttsModel ?? null,
      ttsVoice: input.ttsVoice ?? 'alloy',
      imageHosts: input.imageHosts ?? '',
      proactiveEnabled: input.proactiveEnabled ?? false,
      enabled: input.enabled ?? true,
      dailyBudgetCents: input.dailyBudgetCents ?? 0,
      monthlyBudgetCents: input.monthlyBudgetCents ?? 0,
      budgetPolicy: input.budgetPolicy ?? 'downgrade',
      credentialId: input.credentialId ?? null,
      modelMain: input.modelMain ?? null,
      modelCheap: input.modelCheap ?? null,
      modelFallback: input.modelFallback ?? null,
      modelTemperature: input.modelTemperature ?? 0.85,
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
      // 四字段铺满四个槽位（与真实 QQ 清单同形）：adapterConfig 的翻译才有东西可测（D041）
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
        { key: 'selfId', label: '机器人账号', type: 'text', required: true, mapsTo: 'accountId' },
      ],
    },
    create: (deps) => {
      const adapter = new StubAdapter(deps);
      adapter.failConnect = options.failConnect ?? false;
      created.push(adapter);
      return adapter;
    },
  });

  const runtime = new InstanceRuntime();
  const ownedCredentials = new Set<string>(['cred-own']);
  const credentials = {
    async findForUser(_userId: string, id: string): Promise<unknown | null> {
      return ownedCredentials.has(id) ? { id } : null;
    },
  };
  const configCache = {
    invalidated: [] as string[],
    invalidate(instanceId: string): number {
      this.invalidated.push(instanceId);
      return 1;
    },
  };
  const pipelineHandled: unknown[] = [];
  const pipeline = {
    async handle(message: unknown): Promise<void> {
      pipelineHandled.push(message);
    },
  };
  const service = new InstanceService({
    instances: repo,
    keyStore,
    configCache,
    credentials,
    registry,
    runtime,
    audit: new AuditService(auditRepo),
    pipeline: pipeline,
  });

  return { repo, configCache, credentials, auditRepo, keyStore, registry, runtime, service, created, pipelineHandled };
}

describe('InstanceService 配置与隔离', () => {
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

  it('绑定自己的 Key 成功，别人的 Key 被拒（不能靠 credentialId 白嫖额度）', async () => {
    const { service } = setup();

    const ok = await service.create(actor(ALICE), {
      name: '绑自己的 Key',
      accountId: '10005',
      adapterMode: 'client',
      credentialId: 'cred-own',
      modelMain: 'deepseek-chat',
    });
    expect(ok.credentialId).toBe('cred-own');
    expect(ok.modelMain).toBe('deepseek-chat');

    await expect(
      service.create(actor(ALICE), {
        name: '绑别人的 Key',
        accountId: '10006',
        adapterMode: 'client',
        credentialId: 'cred-someone-else',
      }),
    ).rejects.toThrow(/无权使用/);
  });

  it('换 Provider：改 credentialId 与模型即可，无需重连', async () => {
    const { service, configCache } = setup();
    const dto = await service.create(actor(ALICE), {
      name: '换模型',
      accountId: '10007',
      adapterMode: 'client',
      credentialId: 'cred-own',
    });

    const updated = await service.update(actor(ALICE), dto.id, {
      credentialId: 'cred-own',
      modelMain: 'gpt-5',
      modelCheap: 'gpt-5-mini',
      modelTemperature: 0.6,
    });

    expect(updated.modelMain).toBe('gpt-5');
    expect(updated.modelCheap).toBe('gpt-5-mini');
    expect(updated.modelTemperature).toBe(0.6);
    expect(configCache.invalidated).toContain(dto.id);
  });

  it('改配置后立刻失效配置缓存（否则用户要等 30 秒才生效）', async () => {
    const { service, configCache } = setup();
    const dto = await service.create(actor(ALICE), {
      name: '缓存验证',
      accountId: '10004',
      adapterMode: 'client',
    });

    await service.update(actor(ALICE), dto.id, { modelMain: 'gpt-5' });

    expect(configCache.invalidated).toContain(dto.id);
  });

  it('预算挂在人格（实例）上，换 Key 不会重置（D024）', async () => {
    const { repo, service } = setup();

    const dto = await service.create(actor(ALICE), {
      name: '限额号',
      accountId: '10003',
      adapterMode: 'client',
      dailyBudgetCents: 500,
      monthlyBudgetCents: 8000,
      budgetPolicy: 'block',
    });

    expect(dto.dailyBudgetCents).toBe(500);
    expect(dto.monthlyBudgetCents).toBe(8000);
    expect(dto.budgetPolicy).toBe('block');
    // 落库的是人格（实例）行，不是 Key 行 —— 换 credentialId 时这些值不受影响
    expect(repo.created[0]?.dailyBudgetCents).toBe(500);
    expect(repo.created[0]?.monthlyBudgetCents).toBe(8000);

    const updated = await service.update(actor(ALICE), dto.id, { dailyBudgetCents: 0 });
    expect(updated.dailyBudgetCents).toBe(0);
    // 只改日预算，月预算与策略保持不动
    expect(updated.monthlyBudgetCents).toBe(8000);
    expect(updated.budgetPolicy).toBe('block');
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

  it('maps the stored columns into adapter config and forwards inbound to pipeline', async () => {
    const { keyStore, service, runtime, created, repo, auditRepo, pipelineHandled } = setup();
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

    const inbound: InboundMessage = {
      id: 'msg-1',
      platform: 'qq',
      instanceId: dto.id,
      session: { kind: 'private', peerId: '20002' },
      sender: { id: '20002', name: '小明', isOwner: false },
      segments: [{ type: 'text', text: 'ping' }],
      plainText: 'ping',
      isMentioned: true,
      receivedAt: new Date(),
    };
    adapter.messageHandler?.(inbound);

    // M2：入站消息不再回 pong，而是原样转发给 Pipeline（由 Pipeline 决定回什么）
    expect(pipelineHandled).toHaveLength(1);
    expect(pipelineHandled[0]).toMatchObject({ id: 'msg-1', plainText: 'ping' });
    // 出站由 Pipeline 通过 send 回调发，实例自己不再直接发
    expect(adapter.sent).toHaveLength(0);
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

describe('InstanceService 适配器配置（D041）', () => {
  /** 前端"新建实例"实际提交的形状：只有清单里的键 */
  const CONFIG = {
    mode: 'server',
    wsUrl: 'ws://127.0.0.1:3002',
    accessToken: TOKEN,
    selfId: '10001',
  };

  it('按清单翻译成四个实例列，账号来自 selfId 而不是前端硬写的 accountId', async () => {
    const { repo, keyStore, service } = setup();
    const dek = randomDek();
    keyStore.set(SESSION_ALICE, ALICE, dek);

    const dto = await service.create(actor(ALICE), {
      name: '主号',
      platform: 'qq',
      adapterType: 'onebot',
      adapterConfig: CONFIG,
    });

    const stored = repo.created[0]!;
    expect(stored.accountId).toBe('10001');
    expect(stored.endpoint).toBe('ws://127.0.0.1:3002');
    expect(stored.adapterMode).toBe('server');
    expect(decryptWithDek(stored.accessTokenEnc!, dek)).toBe(TOKEN);
    expect(dto.hasAccessToken).toBe(true);
  });

  it('反向模式漏 token → 400（这条规则来自清单的 requiredWhen，而不是前端硬编码）', async () => {
    const { service } = setup();
    await expect(
      service.create(actor(ALICE), {
        name: '主号',
        adapterConfig: { ...CONFIG, accessToken: '' },
      }),
    ).rejects.toThrow(/Access Token/);
  });

  it('清单外的字段 → 400，而不是静默丢掉', async () => {
    const { service } = setup();
    await expect(
      service.create(actor(ALICE), {
        name: '主号',
        adapterConfig: { ...CONFIG, wssUrl: 'ws://x' },
      }),
    ).rejects.toThrow(/未知字段/);
  });

  it('平台没有注册适配器 → 400 说清是哪个平台', async () => {
    const { service } = setup();
    await expect(
      service.create(actor(ALICE), {
        name: '抖号',
        platform: 'douyin',
        adapterType: 'douyin-open',
        adapterConfig: CONFIG,
      }),
    ).rejects.toThrow(/没有注册适配器：douyin\/douyin-open/);
  });

  it('更新只改动到的那部分：没传的接入参数不进 patch（否则每次保存都重连）', async () => {
    const { service, repo, keyStore } = setup();
    keyStore.set(SESSION_ALICE, ALICE, randomDek());
    const dto = await service.create(actor(ALICE), {
      name: '主号',
      adapterConfig: CONFIG,
    });
    const before = repo.rows.get(dto.id)!.row;

    await service.update(actor(ALICE), dto.id, { adapterConfig: { selfId: '20002' } });

    const after = repo.rows.get(dto.id)!.row;
    expect(after.accountId).toBe('20002');
    // 地址与方向没传，必须原样保留（传了空值同理不能清空）
    expect(after.endpoint).toBe(before.endpoint);
    expect(after.adapterMode).toBe(before.adapterMode);
  });

  it('更新时把必填项改空 → 400', async () => {
    const { service, keyStore } = setup();
    keyStore.set(SESSION_ALICE, ALICE, randomDek());
    const dto = await service.create(actor(ALICE), { name: '主号', adapterConfig: CONFIG });
    await expect(
      service.update(actor(ALICE), dto.id, { adapterConfig: { wsUrl: '   ' } }),
    ).rejects.toThrow(/WebSocket 地址/);
  });

  it('更新别人的实例 → 404（翻译前先按 owner 取，取不到就当作不存在）', async () => {
    const { service, keyStore } = setup();
    keyStore.set(SESSION_ALICE, ALICE, randomDek());
    const dto = await service.create(actor(ALICE), { name: '主号', adapterConfig: CONFIG });
    await expect(
      service.update(actor(BOB), dto.id, { adapterConfig: { selfId: '20002' } }),
    ).rejects.toThrow(/实例不存在/);
  });

  it('改 token 走 adapterConfig 时也要先解锁（密文进库，明文不出内存）', async () => {
    const { service } = setup();
    const dto = await service.create(actor(ALICE), {
      name: '主号',
      adapterConfig: { ...CONFIG, accessToken: '' , mode: 'client' },
    });
    // 未解锁：改 accessToken 必须抛 KEY_LOCKED，而不是存进去一串明文
    await expect(
      service.update(actor(ALICE), dto.id, { adapterConfig: { accessToken: 'new-token' } }),
    ).rejects.toThrow(/解锁/);
  });
});
