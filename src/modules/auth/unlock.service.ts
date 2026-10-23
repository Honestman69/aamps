/**
 * 解锁：把用户密码变成"内存里可用的 DEK"。
 *
 * 流程（SECURITY.md 3.1）：
 *   密码 → Argon2id(keySalt) → KEK → 解开 wrappedDek → DEK 放进 RuntimeKeyStore
 *
 * 两个容易做错的地方：
 *   1. 首次登录时 `wrappedDek` 是 null（建号时只生成 keySalt，见 SECURITY.md 4.1），
 *      此时才生成 DEK 并写库 —— 用 CAS 写，防止并发登录各建一把 DEK。
 *   2. 密码校验通过但解开 wrappedDek 失败，说明**数据被篡改或损坏**，
 *      这是异常而不是"密码错"，不能悄悄生成新 DEK 覆盖掉（那会把用户已有 Key 全废）。
 */

import { AppError, UnauthorizedError } from '@newjob/contracts';

import {
  deriveKek,
  randomDek,
  verifyPassword,
  wipe,
  wrapDek,
} from '../../common/crypto';
import { AuditAction, AuditService } from './audit.service';
import { unwrapStoredDek } from './dek-guard';
import type { IUserAuthRepository } from './ports';
import { DEFAULT_UNLOCK_TTL_MS, RuntimeKeyStore } from './runtime-key-store';

export type UnlockDeps = {
  users: IUserAuthRepository;
  keyStore: RuntimeKeyStore;
  audit: AuditService;
  clock?: () => Date;
};

export type UnlockInput = {
  sessionId: string;
  userId: string;
  password: string;
  ttlMs?: number;
  ip?: string | null;
};

export type UnlockResult = {
  userId: string;
  dekVersion: number;
  /** true 表示这次是首次解锁，顺带生成了 DEK */
  dekCreated: boolean;
  expiresAt: Date;
};

export class UnlockService {
  constructor(private readonly deps: UnlockDeps) {}

  async unlock(input: UnlockInput): Promise<UnlockResult> {
    const { users, keyStore, audit } = this.deps;
    const now = this.deps.clock?.() ?? new Date();

    const record = await users.findAuthById(input.userId);
    // 账号不存在、已停用、密码错误：对外都是同一句话，防枚举
    if (!record || record.status !== 'active') {
      throw new UnauthorizedError('用户名或密码错误');
    }

    const passwordOk = await verifyPassword(record.passwordHash, input.password);
    if (!passwordOk) {
      throw new UnauthorizedError('用户名或密码错误');
    }

    const salt = Buffer.from(record.keySalt, 'hex');
    const kek = await deriveKek(input.password, salt);
    let dek: Buffer;
    let dekCreated = false;
    let dekVersion = record.dekVersion;

    try {
      if (record.wrappedDek) {
        dek = this.unwrap(record.wrappedDek, kek);
      } else {
        dek = randomDek();
        dekCreated = await this.attachNewDek(record.id, dek, kek, record.dekVersion);
        if (!dekCreated) {
          // 并发登录：另一个会话刚写好 wrappedDek，直接用它的（DEK 必须唯一）
          const fresh = await users.findAuthById(record.id);
          if (!fresh?.wrappedDek) {
            wipe(dek);
            throw new AppError('KEYSTORE_CONFLICT', '解锁状态冲突，请重试', 409);
          }
          wipe(dek);
          dek = this.unwrap(fresh.wrappedDek, kek);
          dekVersion = fresh.dekVersion;
        }
      }

      const ttlMs = input.ttlMs ?? DEFAULT_UNLOCK_TTL_MS;
      keyStore.set(input.sessionId, record.id, dek, ttlMs);
      const state = keyStore.getState(input.sessionId);

      await audit.record({
        tenantId: record.tenantId,
        actor: 'user',
        actorUserId: record.id,
        action: AuditAction.CredentialUnlock,
        target: null,
        targetOwnerId: record.id,
        ip: input.ip ?? null,
        after: { dekVersion, dekCreated },
      });

      await users.touchLastLogin(record.id, now);

      return {
        userId: record.id,
        dekVersion,
        dekCreated,
        expiresAt: state?.expiresAt ?? new Date(now.getTime() + ttlMs),
      };
    } finally {
      // DEK 已进入密钥库（存的是副本），这里擦掉本地引用；KEK 本来就不该留下
      wipe(kek);
      wipe(dek!);
    }
  }

  /** 主动锁定：只清当前会话 */
  async lock(input: { sessionId: string; userId: string; ip?: string | null }): Promise<boolean> {
    const cleared = this.deps.keyStore.clear(input.sessionId);
    if (cleared) {
      // 审计需要 tenantId，锁定场景拿不到（会话已清），按用户归属补查一次
      const record = await this.deps.users.findAuthById(input.userId);
      if (record) {
        await this.deps.audit.record({
          tenantId: record.tenantId,
          actor: 'user',
          actorUserId: record.id,
          action: AuditAction.CredentialLock,
          targetOwnerId: record.id,
          ip: input.ip ?? null,
        });
      }
    }
    return cleared;
  }

  private unwrap(wrapped: string, kek: Buffer): Buffer {
    // 数据损坏 / 旧格式映射成明确的 AppError，见 dek-guard.ts
    return unwrapStoredDek(wrapped, kek);
  }

  private async attachNewDek(
    userId: string,
    dek: Buffer,
    kek: Buffer,
    expectDekVersion: number,
  ): Promise<boolean> {
    const wrapped = wrapDek(dek, kek);
    return this.deps.users.attachDekIfAbsent({ userId, wrappedDek: wrapped, expectDekVersion });
  }
}
