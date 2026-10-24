/**
 * 凭据服务：**加密侧**唯一的写入口。
 *
 * 三条硬约束：
 *   1. **本模块没有 `decryptApiKey`，也不 import `decryptWithDek`。**
 *      解密调用点最终全局只允许 1 处（`ModelGateway.dispatch`，M2 再加，见 SECURITY.md 5.3）。
 *      现在顺手写一个"方便调试"的解密函数，等于提前长出多个调用点，以后收不回来。
 *   2. 明文（`apiKey`）只在本文件的参数里出现，加密后立刻丢弃；
 *      进数据库的只有 `apiKeyEnc`（密文）与 `keyMasked`（掩码）。
 *   3. 加密必须用**当前会话的 DEK**。取 DEK 走 `RuntimeKeyStore`，
 *      未解锁会抛 `KeyLockedError` —— 不接受"没解锁就存明文"或"用服务端密钥顶上"。
 *
 * 归属隔离靠 Repository，不靠这里：Service 传的 `userId` 一律来自会话，
 * 不接受来自请求体的任何 id（DTO 是 `.strict()`，传了直接 400）。
 */

import { AppError } from '@newjob/contracts';

import { encryptWithDek } from '../../common/crypto';
import { AuditAction, AuditService, type AuditActor } from '../auth/audit.service';
import { RuntimeKeyStore } from '../auth/runtime-key-store';
import {
  maskApiKey,
  toPublicDTO,
  type CreateCredentialInput,
  type CredentialPublicDTO,
  type UpdateCredentialInput,
} from './dto';
import type { CredentialUpdatePatch, ICredentialRepository } from './ports';

/** 调用方身份，全部来自服务端会话（不是请求体） */
export type CredentialActor = {
  sessionId: string;
  userId: string;
  tenantId: string;
  role: string;
  ip?: string | null;
};

export type CredentialDeps = {
  credentials: ICredentialRepository;
  keyStore: RuntimeKeyStore;
  audit: AuditService;
};

/** 统一"不存在"，跨用户与真不存在返回同一句，不泄漏归属 */
function credentialNotFound(): AppError {
  return new AppError('CREDENTIAL_NOT_FOUND', '凭据不存在', 404);
}

function auditActor(role: string): Extract<AuditActor, 'superadmin' | 'user'> {
  return role === 'superadmin' ? 'superadmin' : 'user';
}

export class CredentialService {
  constructor(private readonly deps: CredentialDeps) {}

  /** 取当前会话的 DEK；未解锁抛 `KeyLockedError`(401)，绝不降级 */
  private dekFor(sessionId: string): Buffer {
    return this.deps.keyStore.get(sessionId);
  }

  /**
   * 新增。顺序刻意是"先加密、再写库、最后审计"：
   * 加密失败（DEK 不在内存）时不该留下任何半成品记录。
   */
  async create(actor: CredentialActor, input: CreateCredentialInput): Promise<CredentialPublicDTO> {
    const dek = this.dekFor(actor.sessionId);
    const apiKeyEnc = encryptWithDek(input.apiKey, dek);

    const row = await this.deps.credentials.createForUser({
      tenantId: actor.tenantId,
      ownerUserId: actor.userId,
      provider: input.provider,
      label: input.label,
      ownerLabel: input.ownerLabel ?? null,
      baseUrl: input.baseUrl ?? null,
      authStyle: input.authStyle ?? 'bearer',
      apiVersion: input.apiVersion ?? null,
      apiKeyEnc,
      keyMasked: maskApiKey(input.apiKey),
      defaultModel: input.defaultModel ?? null,
      priority: input.priority ?? 100,
      dailyBudgetCents: input.dailyBudgetCents ?? 0,
      monthlyBudgetCents: input.monthlyBudgetCents ?? 0,
      enabled: input.enabled ?? true,
    });

    await this.deps.audit.record({
      tenantId: actor.tenantId,
      actor: auditActor(actor.role),
      actorUserId: actor.userId,
      action: AuditAction.CredentialCreate,
      target: row.id,
      targetOwnerId: actor.userId,
      ip: actor.ip ?? null,
      // 只记掩码与元数据。审计 payload 里出现明文等于把 Key 写进日志
      after: {
        provider: row.provider,
        label: row.label,
        keyMasked: row.keyMasked,
        baseUrl: row.baseUrl,
        enabled: row.enabled,
      },
    });

    return toPublicDTO(row);
  }

  /** 列表：只返回掩码。**不需要解锁**，锁着也能看有哪些 Key（看不了内容） */
  async list(actor: Pick<CredentialActor, 'userId'>): Promise<CredentialPublicDTO[]> {
    const rows = await this.deps.credentials.listForUser(actor.userId);
    return rows.map(toPublicDTO);
  }

  /**
   * 部分更新。传了 `apiKey` 就算轮换：重新加密 + 更新掩码 + 记 `credential.rotate`。
   * 没传就只改元数据，**不碰密文**（避免无谓地在内存里多解一次、多错一次的机会）。
   */
  async update(
    actor: CredentialActor,
    id: string,
    input: UpdateCredentialInput,
  ): Promise<CredentialPublicDTO> {
    const patch: CredentialUpdatePatch = {};
    if (input.provider !== undefined) patch.provider = input.provider;
    if (input.label !== undefined) patch.label = input.label;
    if (input.ownerLabel !== undefined) patch.ownerLabel = input.ownerLabel;
    if (input.baseUrl !== undefined) patch.baseUrl = input.baseUrl;
    if (input.authStyle !== undefined) patch.authStyle = input.authStyle;
    if (input.apiVersion !== undefined) patch.apiVersion = input.apiVersion;
    if (input.defaultModel !== undefined) patch.defaultModel = input.defaultModel;
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.dailyBudgetCents !== undefined) patch.dailyBudgetCents = input.dailyBudgetCents;
    if (input.monthlyBudgetCents !== undefined) patch.monthlyBudgetCents = input.monthlyBudgetCents;
    if (input.enabled !== undefined) patch.enabled = input.enabled;

    // 只在本函数的栈里存在，加密后即丢弃；不做 `as string` 之类的偷懒断言
    const rotatingKey = input.apiKey ?? null;
    if (rotatingKey !== null) {
      const dek = this.dekFor(actor.sessionId);
      patch.apiKeyEnc = encryptWithDek(rotatingKey, dek);
      patch.keyMasked = maskApiKey(rotatingKey);
    }
    const rotating = rotatingKey !== null;

    const row = await this.deps.credentials.updateForUser(actor.userId, id, patch);
    if (!row) {
      throw credentialNotFound();
    }

    await this.deps.audit.record({
      tenantId: actor.tenantId,
      actor: auditActor(actor.role),
      actorUserId: actor.userId,
      action: rotating ? AuditAction.CredentialRotate : AuditAction.CredentialUpdate,
      target: row.id,
      targetOwnerId: actor.userId,
      ip: actor.ip ?? null,
      after: {
        provider: row.provider,
        label: row.label,
        keyMasked: row.keyMasked,
        enabled: row.enabled,
        keysRotated: rotating,
      },
    });

    return toPublicDTO(row);
  }

  /** 删除。先查一遍只为在审计里留下"删掉的是哪把"（掩码级），不留密文 */
  async remove(actor: CredentialActor, id: string): Promise<{ deleted: true }> {
    const existing = await this.deps.credentials.findForUser(actor.userId, id);
    if (!existing) {
      throw credentialNotFound();
    }
    const deleted = await this.deps.credentials.deleteForUser(actor.userId, id);
    if (!deleted) {
      // 并发删除：另一个请求先删掉了
      throw credentialNotFound();
    }

    await this.deps.audit.record({
      tenantId: actor.tenantId,
      actor: auditActor(actor.role),
      actorUserId: actor.userId,
      action: AuditAction.CredentialDelete,
      target: existing.id,
      targetOwnerId: actor.userId,
      ip: actor.ip ?? null,
      before: {
        provider: existing.provider,
        label: existing.label,
        keyMasked: existing.keyMasked,
      },
    });

    return { deleted: true };
  }
}
