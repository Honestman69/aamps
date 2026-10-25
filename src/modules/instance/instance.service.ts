/**
 * 实例服务：QQ 号的"可切换"就靠这里 —— 一个号一条记录，配置全是数据。
 *
 * 三件必须理解的事：
 *
 * 1. **endpoint / token 从库里来，不从环境变量来。**
 *    本机测完迁到云服务器时，改的是这条记录（或者新建一条指向云端 NapCat），
 *    不是去改服务器上的 `.env` 再重启。
 *
 * 2. **连接必须先解锁。** token 用 owner 的 DEK 加密存储（与凭据同一套体系），
 *    而 DEK 只在用户解锁后存在于内存（D005）。所以进程重启后实例不会自己上线，
 *    要等用户登录/解锁后再点"连接"。这是 D005 的必然代价，不是 bug。
 *
 * 3. **M1 的消息处理是临时回声。** 收到消息回 `pong`，只用来证明链路通。
 *    M2 会换成真正的 Pipeline 入口，届时 `handleInbound` 整段删掉。
 */

import {
  AppError,
  BadRequestError,
  type IAdapter,
  type InboundMessage,
  type OutboundAction,
  type PlatformCapabilities,
} from '@newjob/contracts';

import { decryptWithDek, encryptWithDek, tokenDigest, verifyTokenDigest } from '../../common/crypto';
import { createAdapterLogger } from '../../common/logger/adapter-logger';
import { AdapterRegistry } from '../adapter/adapter-registry';
import { AuditAction, AuditService, type AuditActor } from '../auth/audit.service';
import { RuntimeKeyStore } from '../auth/runtime-key-store';
import {
  toInstanceDTO,
  type CreateInstanceInput,
  type InstancePublicDTO,
  type UpdateInstanceInput,
} from './dto';
import { assertEndpointAllowed } from './endpoint-guard';
import { InstanceRuntime } from './instance-runtime';
import type {
  InstanceConnectConfig,
  InstanceResidentConfig,
  InstanceUpdatePatch,
  IInstanceRepository,
} from './ports';

/**
 * 改动这些字段会让"当前连着的适配器"失效：地址、鉴权、接入方式、账号、开关。
 * 模型与预算不在此列——它们只影响下一条消息怎么处理。
 */
const CONNECTION_AFFECTING_FIELDS = [
  'endpoint',
  'accessTokenEnc',
  'accessTokenDigest',
  'adapterMode',
  'adapterType',
  'platform',
  'accountId',
  'enabled',
] as const;

export type InstanceActor = {
  sessionId: string;
  userId: string;
  tenantId: string;
  role: string;
  ip?: string | null;
};

export type InstanceDeps = {
  instances: IInstanceRepository;
  keyStore: RuntimeKeyStore;
  registry: AdapterRegistry;
  runtime: InstanceRuntime;
  audit: AuditService;
  /**
   * 配置缓存失效器（可选）。写路径改完配置必须清缓存，
   * 否则用户点保存后最多要等 30 秒才生效——那种"改了没反应"的体验会被当成 bug。
   */
  configCache?: { invalidate(instanceId: string): number };
  /**
   * 凭据归属校验。**必填**（模块里一定注入）：允许绑别人的 Key 等于开放盗用通道。
   * 用 `Pick` 只取一个方法，避免整个凭据领域漏进实例模块。
   */
  credentials: { findForUser(userId: string, id: string): Promise<unknown | null> };
  /**
   * 消息主链路（M2）。实例只负责把入站消息交给它，出站回调绑定到当前 adapter。
   * 用最小接口而非整个 PipelineService，避免实例模块反向依赖 pipeline 的细节。
   */
  pipeline: {
    handle(
      message: InboundMessage,
      send: (action: OutboundAction) => Promise<{ messageId: string }>,
      /** 平台能力（D012/D033）：多媒体由能力声明决定，主服务不看平台字符串 */
      options: { capabilities: PlatformCapabilities },
    ): Promise<void>;
  };
};

function instanceNotFound(): AppError {
  return new AppError('INSTANCE_NOT_FOUND', '实例不存在', 404);
}

function auditActor(role: string): Extract<AuditActor, 'superadmin' | 'user'> {
  return role === 'superadmin' ? 'superadmin' : 'user';
}

/** QQ 号属于个人身份信息，审计里只留掩码（硬性规则 6：完整 QQ 号不进日志） */
export function maskAccount(accountId: string): string {
  if (accountId.length <= 4) {
    return '****';
  }
  return `${accountId.slice(0, 2)}****${accountId.slice(-2)}`;
}

export class InstanceService {
  constructor(private readonly deps: InstanceDeps) {}

  async create(actor: InstanceActor, input: CreateInstanceInput): Promise<InstancePublicDTO> {
    const mode = input.adapterMode ?? 'server';

    // 先拦地址：指向公网 NapCat 等于把 QQ 登录态交给对方，不该只靠"记得别填"。
    // 顺序放在 token 校验之前：地址填错是更常见的错误，先报那个更有用。
    if (input.endpoint) {
      assertEndpointAllowed(input.endpoint, input.adapterMode);
    }

    if (mode === 'server' && !input.accessToken) {
      // 反向端是我们自己开的端口，没有 token 就等于对任何能连上的进程开放
      throw new BadRequestError('反向模式必须配置 Access Token（由本服务在握手阶段校验）');
    }

    // 只有配了 token 才需要 DEK；不配 token 的部署（内网 NapCat）不该被要求先解锁
    const accessTokenEnc =
      input.accessToken !== undefined
        ? encryptWithDek(input.accessToken, this.deps.keyStore.get(actor.sessionId))
        : null;
    // 摘要与密文同时写：反向模式靠摘要就能在服务重启后自动监听，不需要 DEK
    const accessTokenDigest =
      input.accessToken !== undefined ? tokenDigest(input.accessToken) : null;

    // 绑 Key 之前先确认这把 Key 是本人的：否则拿到别人的 credentialId 就能白嫖额度
    if (input.credentialId) {
      await this.assertCredentialOwned(actor.userId, input.credentialId);
    }
    // 语音合成的 Key 也必须属于本人：否则等于拿别人的账去合成
    if (input.ttsCredentialId) {
      await this.assertCredentialOwned(actor.userId, input.ttsCredentialId);
    }

    const row = await this.deps.instances.createForUser({
      tenantId: actor.tenantId,
      ownerUserId: actor.userId,
      name: input.name,
      // 平台与接入方式给默认值：QQ + OneBot 是当前唯一实现，但代码里不写死平台判断
      platform: input.platform ?? 'qq',
      accountId: input.accountId,
      adapterType: input.adapterType ?? 'onebot',
      // 默认反向：token 由我们自己校验，且云端部署不需要开入站端口
      adapterMode: mode,
      endpoint: input.endpoint ?? null,
      accessTokenEnc,
      accessTokenDigest,
      enabled: input.enabled ?? true,
      dailyBudgetCents: input.dailyBudgetCents,
      monthlyBudgetCents: input.monthlyBudgetCents,
      budgetPolicy: input.budgetPolicy,
      credentialId: input.credentialId ?? null,
      modelMain: input.modelMain ?? null,
      modelCheap: input.modelCheap ?? null,
      modelFallback: input.modelFallback ?? null,
      modelTemperature: input.modelTemperature,
      modelVision: input.modelVision ?? null,
      ttsCredentialId: input.ttsCredentialId ?? null,
      ttsModel: input.ttsModel ?? null,
      ...(input.ttsVoice !== undefined ? { ttsVoice: input.ttsVoice } : {}),
      ...(input.imageHosts !== undefined ? { imageHosts: input.imageHosts } : {}),
    });

    await this.deps.audit.record({
      tenantId: actor.tenantId,
      actor: auditActor(actor.role),
      actorUserId: actor.userId,
      action: AuditAction.InstanceCreate,
      target: row.id,
      targetOwnerId: actor.userId,
      ip: actor.ip ?? null,
      after: {
        name: row.name,
        platform: row.platform,
        adapterType: row.adapterType,
        accountMasked: maskAccount(row.accountId),
        hasToken: row.hasAccessToken,
      },
    });

    return toInstanceDTO(row);
  }

  async list(actor: Pick<InstanceActor, 'userId'>): Promise<InstancePublicDTO[]> {
    const rows = await this.deps.instances.listForUser(actor.userId);
    return rows.map((row) => {
      // 库里的 status 是上次落盘的快照；进程重启后可能残留 online。
      // 展示值以运行时为准，避免后台显示"在线"其实早就断了。
      const live = this.deps.runtime.get(row.id);
      return toInstanceDTO({ ...row, status: live ? live.getStatus() : 'offline' });
    });
  }

  async update(
    actor: InstanceActor,
    id: string,
    input: UpdateInstanceInput,
  ): Promise<InstancePublicDTO> {
    const patch: InstanceUpdatePatch = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.platform !== undefined) patch.platform = input.platform;
    if (input.accountId !== undefined) patch.accountId = input.accountId;
    if (input.adapterType !== undefined) patch.adapterType = input.adapterType;
    if (input.adapterMode !== undefined) patch.adapterMode = input.adapterMode;
    if (input.endpoint !== undefined) {
      if (input.endpoint !== null) {
        assertEndpointAllowed(input.endpoint, input.adapterMode);
      }
      patch.endpoint = input.endpoint;
    }
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    // 模型与 Key（D021）：切换 Provider 就是改这两类字段，改完清缓存即可，不需要重连
    if (input.credentialId !== undefined) {
      if (input.credentialId !== null) {
        await this.assertCredentialOwned(actor.userId, input.credentialId);
      }
      patch.credentialId = input.credentialId;
    }
    if (input.modelMain !== undefined) patch.modelMain = input.modelMain;
    if (input.modelCheap !== undefined) patch.modelCheap = input.modelCheap;
    if (input.modelFallback !== undefined) patch.modelFallback = input.modelFallback;
    if (input.modelTemperature !== undefined) patch.modelTemperature = input.modelTemperature;

    // 多模态（D033）：改这些不需要重连，只影响后续消息
    if (input.modelVision !== undefined) patch.modelVision = input.modelVision;
    if (input.ttsCredentialId !== undefined) {
      if (input.ttsCredentialId !== null) {
        await this.assertCredentialOwned(actor.userId, input.ttsCredentialId);
      }
      patch.ttsCredentialId = input.ttsCredentialId;
    }
    if (input.ttsModel !== undefined) patch.ttsModel = input.ttsModel;
    if (input.ttsVoice !== undefined) patch.ttsVoice = input.ttsVoice;
    if (input.imageHosts !== undefined) patch.imageHosts = input.imageHosts;

    // 预算是人格级配置（D024）：改它不需要重连，也不碰任何密钥
    if (input.dailyBudgetCents !== undefined) patch.dailyBudgetCents = input.dailyBudgetCents;
    if (input.monthlyBudgetCents !== undefined) patch.monthlyBudgetCents = input.monthlyBudgetCents;
    if (input.budgetPolicy !== undefined) patch.budgetPolicy = input.budgetPolicy;

    // accessToken 三态：不传=不变，null=清空，字符串=替换（替换要先解锁）
    if (input.accessToken === null) {
      patch.accessTokenEnc = null;
      // 摘要必须跟着清：否则摘要还在、明文已经没了，会出现"能监听但没人知道 token 是什么"的怪状态
      patch.accessTokenDigest = null;
    } else if (input.accessToken !== undefined) {
      patch.accessTokenEnc = encryptWithDek(
        input.accessToken,
        this.deps.keyStore.get(actor.sessionId),
      );
      patch.accessTokenDigest = tokenDigest(input.accessToken);
    }

    const row = await this.deps.instances.updateForUser(actor.userId, id, patch);
    if (!row) {
      throw instanceNotFound();
    }
    this.deps.configCache?.invalidate(id);

    // 只有**接入参数**变了才需要重连：改模型/预算/话术不该把连接踢掉，
    // 否则用户改个温度都要等一次重连，群里那几秒就是"机器人掉线"。
    const live = this.deps.runtime.get(id);
    if (live && CONNECTION_AFFECTING_FIELDS.some((field) => field in patch)) {
      await this.disconnectInternal(actor.userId, id, 'config_changed');
    }

    await this.deps.audit.record({
      tenantId: actor.tenantId,
      actor: auditActor(actor.role),
      actorUserId: actor.userId,
      action: AuditAction.InstanceUpdate,
      target: row.id,
      targetOwnerId: actor.userId,
      ip: actor.ip ?? null,
      after: {
        name: row.name,
        platform: row.platform,
        adapterType: row.adapterType,
        accountMasked: maskAccount(row.accountId),
        hasToken: row.hasAccessToken,
        enabled: row.enabled,
      },
    });

    return toInstanceDTO({ ...row, status: 'offline' });
  }

  async remove(actor: InstanceActor, id: string): Promise<{ deleted: true }> {
    const existing = await this.deps.instances.findForUser(actor.userId, id);
    if (!existing) {
      throw instanceNotFound();
    }
    // 先断连接再删行：反过来的话适配器会继续往一个已不存在的实例上发消息
    await this.disconnectInternal(actor.userId, id, 'deleted');

    const deleted = await this.deps.instances.deleteForUser(actor.userId, id);
    if (!deleted) {
      throw instanceNotFound();
    }
    // 删掉的实例不该在缓存里留下幽灵配置
    this.deps.configCache?.invalidate(id);

    await this.deps.audit.record({
      tenantId: actor.tenantId,
      actor: auditActor(actor.role),
      actorUserId: actor.userId,
      action: AuditAction.InstanceDelete,
      target: existing.id,
      targetOwnerId: actor.userId,
      ip: actor.ip ?? null,
      before: {
        name: existing.name,
        platform: existing.platform,
        adapterType: existing.adapterType,
        accountMasked: maskAccount(existing.accountId),
      },
    });

    return { deleted: true };
  }

  /** 连接：解 token → 建适配器 → 接线 → connect()。失败不留运行时残留 */
  async connect(
    actor: InstanceActor,
    id: string,
  ): Promise<{ status: string; accountId: string; platform: string }> {
    const config = await this.deps.instances.findForConnect(actor.userId, id);
    if (!config) {
      throw instanceNotFound();
    }
    if (!config.enabled) {
      throw new BadRequestError('实例已停用，请先启用');
    }
    if (!config.endpoint) {
      throw new BadRequestError('实例缺少接入地址（WebSocket 地址）');
    }
    // 落库时校验过一次，拨号前再校验一次：开关可能被关掉了，而旧记录还在
    assertEndpointAllowed(config.endpoint, config.adapterMode);

    const credentials = await this.resolveCredentials(actor, config);
    const { status } = await this.spinUp({
      config,
      ownerUserId: actor.userId,
      ...credentials,
    });

    await this.deps.audit.record({
      tenantId: actor.tenantId,
      actor: auditActor(actor.role),
      actorUserId: actor.userId,
      action: AuditAction.InstanceConnect,
      target: id,
      targetOwnerId: actor.userId,
      ip: actor.ip ?? null,
      after: {
        platform: config.platform,
        adapterType: config.adapterType,
        accountMasked: maskAccount(config.accountId),
        status,
      },
    });

    return { status, accountId: config.accountId, platform: config.platform };
  }

  /**
   * 把「该用哪把钥匙」和「怎么起适配器」分开。
   *
   * 反向模式只需要摘要：握手是**比对**，不是解密，所以服务重启后没有 DEK 也能监听。
   * 正向模式必须明文：它要作为 `Authorization: Bearer` 发出去。
   */
  private async resolveCredentials(
    actor: InstanceActor,
    config: InstanceConnectConfig,
  ): Promise<{ plainToken?: string; verifyPeerToken?: (provided: string) => boolean }> {
    if (config.adapterMode === 'server') {
      let digest = config.accessTokenDigest;
      if (!digest && config.accessTokenEnc) {
        // 老数据（加摘要列之前建的）：趁用户这次已解锁，顺手把摘要补上，
        // 下次服务重启就能自监听了。失败不影响这次连接。
        const plain = this.decryptToken(actor.sessionId, config.accessTokenEnc);
        digest = tokenDigest(plain);
        await this.deps.instances
          .updateForUser(actor.userId, config.id, { accessTokenDigest: digest })
          .catch(() => undefined);
      }
      if (!digest) {
        throw new BadRequestError(
          '实例缺少 Access Token：反向模式需要它来校验连进来的 NapCat。请重新填写后再连接',
        );
      }
      const expected = digest;
      return { verifyPeerToken: (provided: string) => verifyTokenDigest(provided, expected) };
    }

    // 正向：拿明文去拨号。未解锁会在这里抛 KeyLockedError(401)，不会退化成"用空 token 连"
    if (!config.accessTokenEnc) {
      return {};
    }
    return { plainToken: this.decryptToken(actor.sessionId, config.accessTokenEnc) };
  }

  private decryptToken(sessionId: string, encrypted: string): string {
    const dek = this.deps.keyStore.get(sessionId);
    try {
      return decryptWithDek(encrypted, dek);
    } catch {
      throw new AppError(
        'INSTANCE_TOKEN_UNREADABLE',
        '实例令牌无法解密（密码可能被重置过），请重新填写 Access Token',
        409,
      );
    }
  }

  /** 建适配器 → 接线 → connect → 落状态。connect 与启动自监听共用这一段 */
  private async spinUp(input: {
    config: InstanceConnectConfig;
    ownerUserId: string;
    plainToken?: string;
    verifyPeerToken?: (provided: string) => boolean;
  }): Promise<{ status: string }> {
    const { config } = input;
    const endpoint = config.endpoint;
    if (!endpoint) {
      throw new BadRequestError('实例缺少接入地址（WebSocket 地址）');
    }
    const factory = this.deps.registry.get(config.platform, config.adapterType);

    // 已有连接先断，避免同一个号挂两条 WS（NapCat 侧会发重复消息）
    if (this.deps.runtime.has(config.id)) {
      await this.disconnectInternal(input.ownerUserId, config.id, 'reconnect');
    }

    const adapter = factory.create({
      instanceId: config.id,
      // 列名 → 适配器配置字段名。这是唯一一处"平台配置"的映射，
      // 不同协议需要不同字段时，在这里按 manifest.configFields 演化。
      config: {
        // endpoint 在两种 mode 下含义不同：
        //   server = 本端监听地址（NapCat 连过来），client = 对方地址（我们连过去）
        mode: config.adapterMode,
        wsUrl: endpoint,
        selfId: config.accountId,
        ...(input.plainToken ? { accessToken: input.plainToken } : {}),
      },
      ...(input.verifyPeerToken ? { verifyPeerToken: input.verifyPeerToken } : {}),
      logger: createAdapterLogger(`instance:${config.id}`),
    });

    adapter.onMessage((message) => this.handleInbound(adapter, message));
    adapter.onPlatformEvent(() => {
      // M1 不处理平台事件（进群/退群等），M3 的社交反应策略再接
    });
    adapter.onAdapterEvent((event) => {
      if (event.kind === 'status') {
        void this.deps.instances
          .setStatusForUser(input.ownerUserId, config.id, event.status)
          .catch(() => undefined);
      }
      if (event.kind === 'send-blocked') {
        // 风控信号：M6 的 risk.worker 会据此降级，这里先只落一条 warn
        createAdapterLogger(`instance:${config.id}`).warn(
          { event: 'adapter.send_blocked', code: event.code },
          '发送被平台拦截',
        );
      }
    });

    try {
      // connect() 内部只尝试一次，所以这里失败就是真失败，不做重试
      await adapter.connect();
    } catch (err) {
      await adapter.disconnect().catch(() => undefined);
      await this.deps.instances
        .setStatusForUser(input.ownerUserId, config.id, 'offline')
        .catch(() => undefined);
      throw new AppError('INSTANCE_CONNECT_FAILED', `连接失败：${(err as Error).message}`, 502);
    }

    this.deps.runtime.set(config.id, adapter);
    await this.deps.instances.setStatusForUser(input.ownerUserId, config.id, adapter.getStatus());
    return { status: adapter.getStatus() };
  }

  /**
   * 服务启动时恢复反向实例的监听。
   *
   * 这一步是"云端能常驻"的前提：反向模式下是我们监听、NapCat 连进来，
   * 如果监听只能由 `connect()` 发起，那么服务每次重启都要有人登录解锁再点一次，
   * 而 DEK 只在内存里（D005）——云端就等于必须有人值守。
   *
   * 为什么这里不需要 DEK：握手只需要判断 token 对不对，摘要足够（见 D019）。
   * 失败不阻断启动，逐个记录后继续（一个实例的端口被占用不该拖垮别的实例）。
   */
  async resumeResidentListeners(): Promise<{ started: number; failed: number; skipped: number }> {
    const rows: InstanceResidentConfig[] = await this.deps.instances.listResidentListenCandidates();
    let started = 0;
    let failed = 0;
    let skipped = 0;

    for (const row of rows) {
      if (this.deps.runtime.has(row.id)) {
        skipped += 1;
        continue;
      }
      try {
        assertEndpointAllowed(row.endpoint!, row.adapterMode);
        const expected = row.accessTokenDigest!;
        await this.spinUp({
          config: row,
          ownerUserId: row.ownerUserId,
          verifyPeerToken: (provided: string) => verifyTokenDigest(provided, expected),
        });
        started += 1;
      } catch (err) {
        failed += 1;
        createAdapterLogger(`instance:${row.id}`).warn(
          { event: 'instance.resume_failed', reason: (err as Error).message },
          '启动自监听失败，已跳过该实例',
        );
      }
    }

    if (rows.length > 0) {
      createAdapterLogger('instance:resume').info(
        { event: 'instance.resume_done', candidates: rows.length, started, failed, skipped },
        '反向实例自监听已恢复',
      );
    }
    return { started, failed, skipped };
  }

  async disconnect(actor: InstanceActor, id: string): Promise<{ status: string }> {
    const existing = await this.deps.instances.findForUser(actor.userId, id);
    if (!existing) {
      throw instanceNotFound();
    }
    await this.disconnectInternal(actor.userId, id, 'user_request');

    await this.deps.audit.record({
      tenantId: actor.tenantId,
      actor: auditActor(actor.role),
      actorUserId: actor.userId,
      action: AuditAction.InstanceDisconnect,
      target: id,
      targetOwnerId: actor.userId,
      ip: actor.ip ?? null,
      after: { reason: 'user_request', accountMasked: maskAccount(existing.accountId) },
    });

    return { status: 'offline' };
  }

  /**
   * 内部断连：**不写审计**（审计由调用方决定记什么原因），
   * 但一定要清运行时与库里的状态 —— 漏掉任何一处都会留下"幽灵连接"。
   */
  /**
   * 校验凭据归属。错误信息合并"不存在"与"无权"，避免靠报错探测别人的 credentialId。
   */
  private async assertCredentialOwned(userId: string, credentialId: string): Promise<void> {
    const owned = await this.deps.credentials.findForUser(userId, credentialId);
    if (!owned) {
      throw new BadRequestError('凭据不存在或无权使用');
    }
  }

  private async disconnectInternal(userId: string, id: string, _reason: string): Promise<void> {
    const adapter = this.deps.runtime.get(id);
    if (adapter) {
      await adapter.disconnect().catch(() => undefined);
      this.deps.runtime.remove(id);
    }
    await this.deps.instances.setStatusForUser(userId, id, 'offline').catch(() => undefined);
  }

  /**
   * 入站消息入口：转发给 Pipeline。
   *
   * 这里只负责"把消息交给主链路"，不再有任何回显/业务逻辑 —— 那条链在
   * `PipelineService` 里（D020/D024/D025/D028/D030/D031 都在那里落地）。
   *
   * Pipeline 永不 throw：它内部把所有失败都转成"兜底话术或静默"，所以这里
   * 不需要 try/catch，也不该再包一层。
   */
  private handleInbound(adapter: IAdapter, message: InboundMessage): void {
    const pipeline = this.deps.pipeline;
    if (!pipeline) {
      // 没有注入 Pipeline（理论上不该发生，装配时一定注入）—— 静默，别回 pong 误导
      return;
    }
    void pipeline.handle(message, (action) => adapter.send(action), {
      // 能力由适配器声明，主服务不判断平台字符串（D012）
      capabilities: adapter.capabilities,
    });
  }
}
