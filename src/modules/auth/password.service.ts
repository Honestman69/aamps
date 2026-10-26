/**
 * 密码变更：两条**语义相反**的路径，必须分开实现（D004 / SECURITY.md 5.1）。
 *
 *   路径 A `changePassword`：本人改，校验旧密码 → 用同一个 DEK 重新包裹 → **Key 全部保留**
 *   路径 B `resetPassword`：管理员重置他人 → 销毁 wrappedDek → **Key 全部报废**
 *   路径 C `resetPasswordSelf`：本人忘记密码（无法证明身份）→ 与 B 同样销毁
 *
 * 判定依据是**操作者是否等于目标用户**，不是角色。superadmin 改自己的密码也走 A。
 *
 * 合并成一个接口必有一边是错的：
 *   - 合并成 A：管理员重置后能登录读 Key，隔离失效；
 *   - 合并成 B：本人改个密码把 Key 全废，体验灾难。
 *
 * 路径 A 的事务性要求极高：`passwordHash` 与 `wrappedDek` 必须同时写入。
 * 只写成功一个，用户下次登录就会解不开 DEK，Key 全部报废 —— 这是最难排查的数据损坏。
 * 所以写入走 Repository 的 CAS 单事务方法，失败即整体回滚。
 */

import { BadRequestError, ForbiddenError, UnauthorizedError } from '@newjob/contracts';

import {
  deriveKek,
  hashPassword,
  verifyPassword,
  wipe,
  wrapDek,
} from '../../common/crypto';
import { AuditAction, AuditService, type AuditActor } from './audit.service';
import { unwrapStoredDek } from './dek-guard';
import type { ICredentialAdminRepository, IUserAuthRepository } from './ports';
import { DEFAULT_UNLOCK_TTL_MS, RuntimeKeyStore } from './runtime-key-store';

/** 密码最短长度。自用系统，但 12 位起步，省得后面改 */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * 密码强度：所有"设置密码"的入口（本人改密、管理员重置、建号）都走这一个函数。
 *
 * 为什么不在 zod 里做：规则会变（将来可能要求字符类别），而 zod schema 是"形态"，
 * 强度是"业务"。写两处必然漂移 —— 到时会出现"建号能过、改密被拒"。
 */
export function assertPasswordPolicy(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new BadRequestError(`密码至少 ${MIN_PASSWORD_LENGTH} 位`);
  }
}

export type PasswordDeps = {
  users: IUserAuthRepository;
  credentials: ICredentialAdminRepository;
  keyStore: RuntimeKeyStore;
  audit: AuditService;
  clock?: () => Date;
};

export type ChangePasswordInput = {
  sessionId: string;
  /** 操作者 = 目标用户（本人改密） */
  userId: string;
  oldPassword: string;
  newPassword: string;
  ip?: string | null;
  /** 改密后当前会话的解锁有效期 */
  ttlMs?: number;
};

export type ResetPasswordInput = {
  /** 操作者。必须不等于 targetUserId，否则拒绝 */
  actorUserId: string;
  actor: Extract<AuditActor, 'superadmin' | 'user'>;
  targetUserId: string;
  /** 管理员设置的临时密码；用户下次登录后必须自行再改 */
  newPassword: string;
  reason?: string;
  ip?: string | null;
};

export type ResetPasswordResult = {
  dekVersion: number;
  disabledCredentials: number;
  clearedSessions: number;
};

export class PasswordService {
  constructor(private readonly deps: PasswordDeps) {}

  /**
   * 路径 A：本人改密码。Key **不受影响**。
   *
   * 因为持旧密码 → 能解出 DEK → 用新密码派生的 KEK 重新包裹同一个 DEK，
   * 密文 `apiKeyEnc` 一个字节都不动。
   */
  async changePassword(input: ChangePasswordInput): Promise<{ dekVersion: number }> {
    const { users, keyStore, audit } = this.deps;
    assertPasswordPolicy(input.newPassword);

    const record = await users.findAuthById(input.userId);
    if (!record || record.status !== 'active') {
      throw new ForbiddenError('无权操作该账号');
    }
    if (!record.wrappedDek) {
      // 重置后尚未解锁：此时没有 DEK 可保留，改密没有意义，先解锁
      throw new ForbiddenError('密钥库尚未初始化，请先登录解锁后再修改密码');
    }

    const oldOk = await verifyPassword(record.passwordHash, input.oldPassword);
    if (!oldOk) {
      throw new UnauthorizedError('旧密码不正确');
    }
    if (input.oldPassword === input.newPassword) {
      throw new BadRequestError('新密码不能与旧密码相同');
    }

    const salt = Buffer.from(record.keySalt, 'hex');
    const oldKek = await deriveKek(input.oldPassword, salt);
    // 解不开/格式坏/旧格式 → 统一由 dek-guard 映射成明确的 AppError
    let dek: Buffer = unwrapStoredDek(record.wrappedDek, oldKek);

    const newHash = await hashPassword(input.newPassword);
    const newKek = await deriveKek(input.newPassword, salt);
    const newWrapped = wrapDek(dek, newKek);

    try {
      const updated = await users.updateSecretsAtomically({
        userId: record.id,
        expectPasswordHash: record.passwordHash,
        expectWrappedDek: record.wrappedDek,
        passwordHash: newHash,
        wrappedDek: newWrapped,
      });
      if (!updated) {
        // CAS 失败 = 期间有别的会话改过密码。此时绝不能强行覆盖
        throw new ForbiddenError('密码已被其他会话修改，请重新登录后再试');
      }

      // 迫使其他设备重新登录；当前会话继续可用（DEK 没变，没必要把本人踢下线）
      keyStore.clearForUser(record.id);
      keyStore.set(input.sessionId, record.id, dek, input.ttlMs ?? DEFAULT_UNLOCK_TTL_MS);

      await audit.record({
        tenantId: record.tenantId,
        actor: 'user',
        actorUserId: record.id,
        action: AuditAction.UserPasswordChange,
        targetOwnerId: record.id,
        ip: input.ip ?? null,
        // 只记状态，不记任何密钥材料
        after: { dekVersion: record.dekVersion, rewrapped: true, keysUnaffected: true },
      });

      return { dekVersion: record.dekVersion };
    } finally {
      wipe(dek);
      wipe(oldKek);
      wipe(newKek);
    }
  }

  /**
   * 路径 B：管理员重置他人密码。Key **永久报废**。
   *
   * 管理员手里没有旧密码，技术上不可能保留 Key —— 解不开 DEK，留着密文也没意义。
   * 所以重置必然等于销毁，界面上必须红字告知。
   */
  async resetPassword(input: ResetPasswordInput): Promise<ResetPasswordResult> {
    const { users, credentials, keyStore, audit } = this.deps;
    assertPasswordPolicy(input.newPassword);

    if (input.actorUserId === input.targetUserId) {
      // 本人改密必须走 changePassword。这里必须拒绝，否则又是一条"管理员读 Key"的合法通道
      throw new ForbiddenError('本人修改密码请使用修改密码流程，重置会销毁全部密钥');
    }

    const target = await users.findAuthById(input.targetUserId);
    if (!target) {
      // 不区分"不存在"和"无权"（防枚举）
      throw new ForbiddenError('无权操作该账号');
    }

    const newHash = await hashPassword(input.newPassword);
    const replaced = await users.replacePasswordAndDestroyDek({
      userId: target.id,
      passwordHash: newHash,
      expectDekVersion: target.dekVersion,
    });
    if (!replaced) {
      throw new ForbiddenError('账号状态已变化，请刷新后重试');
    }

    const disabledCredentials = await credentials.disableAllForUser(
      target.id,
      '密码已重置，密钥需重新录入',
    );
    const clearedSessions = keyStore.clearForUser(target.id);

    await audit.record({
      tenantId: target.tenantId,
      actor: input.actor,
      actorUserId: input.actorUserId,
      action: AuditAction.UserPasswordReset,
      target: `user:${target.id}`,
      targetOwnerId: target.id,
      ip: input.ip ?? null,
      after: {
        dekVersion: target.dekVersion + 1,
        wrapDekDestroyed: true,
        disabledCredentials,
        clearedSessions,
        reason: input.reason ?? null,
      },
    });

    return { dekVersion: target.dekVersion + 1, disabledCredentials, clearedSessions };
  }

  /**
   * 路径 C：本人忘记密码。**复用销毁语义，不复用重包裹逻辑**。
   *
   * 无法证明身份 = 视同重置。这个方法只应该被"本地控制台 / 运维脚本"调用，
   * **绝对不能**挂成未认证的 HTTP 接口（否则等于给了任何人一个账号接管入口）。
   */
  async resetPasswordSelf(input: {
    username: string;
    newPassword: string;
    ip?: string | null;
  }): Promise<ResetPasswordResult & { matched: boolean }> {
    const { users, credentials, keyStore, audit } = this.deps;
    assertPasswordPolicy(input.newPassword);

    const target = await users.findForLogin(input.username);
    if (!target) {
      // 防枚举：不暴露账号是否存在，也不写审计（否则会被当成探测工具）
      return { matched: false, dekVersion: 0, disabledCredentials: 0, clearedSessions: 0 };
    }

    const newHash = await hashPassword(input.newPassword);
    const replaced = await users.replacePasswordAndDestroyDek({
      userId: target.id,
      passwordHash: newHash,
      expectDekVersion: target.dekVersion,
    });
    if (!replaced) {
      throw new ForbiddenError('账号状态已变化，请重试');
    }

    const disabledCredentials = await credentials.disableAllForUser(
      target.id,
      '密码已重置，密钥需重新录入',
    );
    const clearedSessions = keyStore.clearForUser(target.id);

    await audit.record({
      tenantId: target.tenantId,
      actor: 'user',
      actorUserId: target.id,
      action: AuditAction.UserPasswordResetSelf,
      target: `user:${target.id}`,
      targetOwnerId: target.id,
      ip: input.ip ?? null,
      after: {
        dekVersion: target.dekVersion + 1,
        wrapDekDestroyed: true,
        disabledCredentials,
        clearedSessions,
      },
    });

    return { matched: true, dekVersion: target.dekVersion + 1, disabledCredentials, clearedSessions };
  }

}
