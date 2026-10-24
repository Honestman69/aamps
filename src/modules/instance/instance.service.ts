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
} from '@newjob/contracts';

import { decryptWithDek, encryptWithDek, tokenDigest, verifyTokenDigest } from '../../common/crypto';
import { createAdapterLogger } from '../../common/logger/adapter-logger';
import { AdapterRegistry } from '../adapter/adapter-registry';
import type { IAgentRepository } from '../agent/ports';
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

export type InstanceActor = {
  sessionId: string;
  userId: string;
  tenantId: string;
  role: string;
  ip?: string | null;
};

export type InstanceDeps = {
  instances: IInstanceRepository;
  /** M1/M2 阶段实例自动挂用户的默认 Agent（D020） */
  agents: IAgentRepository;
  keyStore: RuntimeKeyStore;
  registry: AdapterRegistry;
  runtime: InstanceRuntime;
  audit: AuditService;
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

    // 记忆与人格属于 Agent（D020）。还没有 Agent 管理页时，先保证存在一个默认 Agent，
    // 让实例永远有归属，避免出现"这个号是谁的"这种孤儿数据。
    const agent = await this.deps.agents.ensureDefaultForUser(actor.tenantId, actor.userId);

    const row = await this.deps.instances.createForUser({
      tenantId: actor.tenantId,
      ownerUserId: actor.userId,
      agentId: agent.id,
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
        agentId: row.agentId,
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

    // 改了接入参数就得重连，否则适配器还拿着旧地址 —— 静默继续跑比断开更糟
    const live = this.deps.runtime.get(id);
    if (live) {
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
  private async disconnectInternal(userId: string, id: string, _reason: string): Promise<void> {
    const adapter = this.deps.runtime.get(id);
    if (adapter) {
      await adapter.disconnect().catch(() => undefined);
      this.deps.runtime.remove(id);
    }
    await this.deps.instances.setStatusForUser(userId, id, 'offline').catch(() => undefined);
  }

  /**
   * 入站消息处理（M1 临时）。
   *
   * 只做一件事：回 `pong`。目的是让"NapCat → 主服务 → NapCat → QQ"这条链路
   * 能在没有模型、没有人设、没有规则的情况下先跑通，把协议问题与业务问题分开。
   * **M2 会把这一段整个替换成 Pipeline 入口**，不要在这上面加业务逻辑。
   */
  private handleInbound(adapter: IAdapter, message: InboundMessage): void {
    if (!message.plainText.trim()) {
      return;
    }
    // 刻意**不带** replyToMessageId：引用回复是"这条消息需要指回上一条"的表达手段，
    // 真人对每句话都点引用会显得很机械。协议层支持（OutboundAction.replyToMessageId
    // → OneBot 的 reply 段）保留不动，什么时候引用由 M3 的表达层按语境决定，
    // 不该在这个连 AI 都还没接上的占位回声里替它做决定。
    const action: OutboundAction = {
      kind: 'send',
      session: message.session,
      segments: [{ type: 'text', text: 'pong' }],
    };
    adapter.send(action).catch((err: Error) => {
      createAdapterLogger(`instance:${message.instanceId}`).warn(
        { event: 'adapter.echo_failed', reason: err.message },
        '回声发送失败',
      );
    });
  }
}
