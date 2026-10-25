/**
 * 运行时密钥库：DEK 唯一允许驻留的地方（D005）。
 *
 * 硬约束，改代码前先读：
 *   1. **不持久化**。不落盘、不进 Redis、不进日志、不进审计 payload。进程重启即丢失，
 *      用户需重新解锁。任何"为了重启后自动恢复"而加的持久化，等于放弃整个隔离模型。
 *   2. **不进日志**。`toJSON()` 被刻意改写成只输出条目数，`JSON.stringify(store)`
 *      不会泄漏任何 DEK。
 *   3. **过期即视为不存在**。取用时不返回"已过期但还能用"的旧值，直接抛 `KeyLockedError`，
 *      不允许上层降级到默认值。
 *
 * key 是 sessionId 而不是 userId：同一用户多端登录各持一份，销号只影响对应会话。
 */

import { KeyLockedError } from '@newjob/contracts';

import { CryptoError, DEK_BYTES } from '../../common/crypto';

/** 默认解锁态有效期：7 天（SECURITY.md 3.2 建议值） */
export const DEFAULT_UNLOCK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type UnlockState = {
  userId: string;
  /** 只在这里存，且只以 Buffer 形式存 */
  dek: Buffer;
  unlockedAt: Date;
  expiresAt: Date;
};

export class RuntimeKeyStore {
  private readonly sessions = new Map<string, UnlockState>();

  constructor(private readonly clock: () => Date = () => new Date()) {}

  /**
   * 放入一份 DEK。
   * 存的是**副本**：调用方在 unlock 流程结束后会擦掉自己手里的 buffer，
   * 如果共享同一个引用，密钥库会被连带清成 0。
   */
  set(sessionId: string, userId: string, dek: Buffer, ttlMs: number = DEFAULT_UNLOCK_TTL_MS): void {
    if (!sessionId) {
      throw new CryptoError('CRYPTO_SESSION_INVALID', 'sessionId 不能为空');
    }
    if (!Buffer.isBuffer(dek) || dek.length !== DEK_BYTES) {
      throw new CryptoError('CRYPTO_KEY_INVALID', 'DEK 长度必须是 32 字节');
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new CryptoError('CRYPTO_TTL_INVALID', '解锁有效期必须为正数');
    }

    const existing = this.sessions.get(sessionId);
    if (existing) {
      // 覆盖前把旧 DEK 擦掉，避免同一会话反复解锁时在堆上留一堆副本
      existing.dek.fill(0);
    }

    const now = this.clock();
    this.sessions.set(sessionId, {
      userId,
      dek: Buffer.from(dek),
      unlockedAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
    });
  }

  /** 取 DEK。未解锁 / 已过期一律抛 `KeyLockedError`，不返回 null */
  get(sessionId: string): Buffer {
    const state = this.getState(sessionId);
    if (!state) {
      throw new KeyLockedError();
    }
    return state.dek;
  }

  /**
   * 按用户取一份未过期的 DEK。
   *
   * 为什么需要它：**消息主链路没有登录会话**。QQ 消息来自协议端，不来自浏览器，
   * 它手里只有一个 chat session id 和 ownerUserId。而解密 API Key 必须有 DEK
   * （D003/D005），DEK 又是挂在登录会话上的。两者对不上，表现就是"机器人收到消息
   * 却一条都不回"（`KeyLockedError` 被主链路当成"没解锁"静默处理）。
   *
   * 语义：该用户的**任一**未过期解锁态都可以用 —— DEK 是用户级的（同一个密码派生出同一份），
   * 多端登录只是各持一份副本。过期的直接跳过，不返回，也不在这里清理（清理归调用清理的路径）。
   *
   * 找不到仍然抛 `KeyLockedError`：这是"owner 需要去后台登录一次"，不是可以降级的故障。
   */
  getForUser(userId: string): Buffer {
    const now = this.clock().getTime();
    for (const state of this.sessions.values()) {
      if (state.userId !== userId) {
        continue;
      }
      if (state.expiresAt.getTime() <= now) {
        continue;
      }
      return state.dek;
    }
    throw new KeyLockedError();
  }

  /** 取完整状态（解锁时间、过期时间），供后台状态条使用 */
  getState(sessionId: string): UnlockState | null {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return null;
    }
    if (state.expiresAt.getTime() <= this.clock().getTime()) {
      this.clear(sessionId);
      return null;
    }
    return state;
  }

  isUnlocked(sessionId: string): boolean {
    return this.getState(sessionId) !== null;
  }

  /** 会话结束 / 主动锁定时调用。返回是否真的删掉了东西 */
  clear(sessionId: string): boolean {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return false;
    }
    state.dek.fill(0);
    this.sessions.delete(sessionId);
    return true;
  }

  /**
   * 清掉某个用户的**全部**会话。
   * 用于：改密码后迫使其他设备重新登录、管理员重置密码、账号停用。
   * 返回清掉的会话数。
   */
  clearForUser(userId: string): number {
    let removed = 0;
    for (const [sessionId, state] of [...this.sessions.entries()]) {
      if (state.userId === userId) {
        state.dek.fill(0);
        this.sessions.delete(sessionId);
        removed += 1;
      }
    }
    return removed;
  }

  /** 续期（用户活跃时滚动延长），不改变 DEK 本身 */
  touch(sessionId: string, ttlMs: number = DEFAULT_UNLOCK_TTL_MS): boolean {
    const state = this.getState(sessionId);
    if (!state) {
      return false;
    }
    state.expiresAt = new Date(this.clock().getTime() + ttlMs);
    return true;
  }

  /** 定期清理过期条目（定时任务可调；取用时也会顺带清） */
  purgeExpired(): number {
    let removed = 0;
    const now = this.clock().getTime();
    for (const [sessionId, state] of [...this.sessions.entries()]) {
      if (state.expiresAt.getTime() <= now) {
        state.dek.fill(0);
        this.sessions.delete(sessionId);
        removed += 1;
      }
    }
    return removed;
  }

  size(): number {
    return this.sessions.size;
  }

  /**
   * 防泄漏：`JSON.stringify(store)` 或 `console.log(store)` 只输出条目数。
   * 这不是洁癖 —— 调试时随手打印一个对象，DEK 就会进日志文件。
   */
  toJSON(): { unlockedSessions: number } {
    return { unlockedSessions: this.sessions.size };
  }
}
