/**
 * 会话：服务端内存会话 + HMAC 签名的 sessionId cookie。
 *
 * 为什么不用 JWT：
 *   会话里唯一需要携带的是 sessionId（DEK 存在服务端内存，按 sessionId 索引）。
 *   JWT 需要额外依赖、且把状态塞进令牌反而更难撤销。这里签个名就够：
 *   客户端只能拿到 `id.hmac`，改一个字符就验不过。
 *
 * 硬约束：
 *   1. cookie 里**只有 sessionId**，绝不含 userId / DEK / 任何密钥材料。
 *   2. 会话在内存里，进程重启即失效 —— 与 D005 一致（重启要重新解锁）。
 *   3. 撤销会话（改密、重置、锁定）必须能立即生效，所以不用无状态令牌。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { randomBytes } from '../../common/crypto';

export const SESSION_COOKIE = 'aamps_sid';

export type SessionRecord = {
  id: string;
  userId: string;
  tenantId: string;
  role: string;
  createdAt: Date;
  expiresAt: Date;
};

export class SessionService {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(
    private readonly secret: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (!secret || secret.length < 32) {
      throw new Error('SESSION_SECRET 至少 32 字符');
    }
  }

  create(input: { userId: string; tenantId: string; role: string }, ttlMs: number): SessionRecord {
    const id = randomBytes(32).toString('base64url');
    const now = this.clock();
    const record: SessionRecord = {
      id,
      userId: input.userId,
      tenantId: input.tenantId,
      role: input.role,
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
    };
    this.sessions.set(id, record);
    return record;
  }

  /** 解析并校验 cookie 值，失败返回 null（不抛异常，由守卫转 401） */
  verifyCookie(raw: string | undefined): SessionRecord | null {
    if (!raw) {
      return null;
    }
    const dot = raw.lastIndexOf('.');
    if (dot <= 0) {
      return null;
    }
    const id = raw.slice(0, dot);
    const signature = raw.slice(dot + 1);
    if (!this.verifySignature(id, signature)) {
      return null;
    }
    const record = this.sessions.get(id);
    if (!record) {
      return null;
    }
    if (record.expiresAt.getTime() <= this.clock().getTime()) {
      this.sessions.delete(id);
      return null;
    }
    return record;
  }

  /** 生成写进 Set-Cookie 的值 */
  signCookie(sessionId: string): string {
    return `${sessionId}.${this.sign(sessionId)}`;
  }

  destroy(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /** 撤销某用户的全部会话（改密后迫使其他设备重新登录） */
  destroyForUser(userId: string): number {
    let removed = 0;
    for (const [id, record] of [...this.sessions.entries()]) {
      if (record.userId === userId) {
        this.sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * 撤销该用户的**其他**会话，保留当前这一个。
   * 本人改密后应该把别的设备踢下线，但没必要把自己也踢了（DEK 并未改变）。
   */
  destroyOthersForUser(userId: string, keepSessionId: string): number {
    let removed = 0;
    for (const [id, record] of [...this.sessions.entries()]) {
      if (record.userId === userId && id !== keepSessionId) {
        this.sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  get(sessionId: string): SessionRecord | null {
    const record = this.sessions.get(sessionId);
    if (!record || record.expiresAt.getTime() <= this.clock().getTime()) {
      return null;
    }
    return record;
  }

  size(): number {
    return this.sessions.size;
  }

  /** 调试打印时不要泄漏 sessionId */
  toJSON(): { activeSessions: number } {
    return { activeSessions: this.sessions.size };
  }

  private sign(sessionId: string): string {
    return createHmac('sha256', this.secret).update(sessionId).digest('base64url');
  }

  private verifySignature(sessionId: string, signature: string): boolean {
    const expected = this.sign(sessionId);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length) {
      return false;
    }
    return timingSafeEqual(a, b);
  }
}

/** Set-Cookie 头。HttpOnly 必开：前端 JS 拿不到 sessionId，XSS 也偷不走 */
export function buildSessionCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

/** 从原始 Cookie 头里取某个键 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) {
    return undefined;
  }
  for (const segment of header.split(';')) {
    const trimmed = segment.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    if (trimmed.slice(0, eq) === name) {
      return decodeURIComponent(trimmed.slice(eq + 1));
    }
  }
  return undefined;
}
