/**
 * auth 模块测试用的内存假仓储。
 *
 * 刻意**复刻真实仓储的 CAS 语义**：只有旧值仍匹配时才写入成功。
 * 如果假实现写成"永远成功"，`changePassword` 的并发保护就测不出来了。
 */

import type { AuditLogRow } from '@/modules/auth/audit.service';
import type {
  IAuditLogRepository,
  ICredentialAdminRepository,
  IUserAuthRepository,
  UserAuthRecord,
} from '@/modules/auth/ports';

export class FakeUserRepository implements IUserAuthRepository {
  readonly users = new Map<string, UserAuthRecord>();
  lastLoginTouched: Array<{ userId: string; at: Date }> = [];

  constructor(seed: UserAuthRecord[]) {
    for (const user of seed) {
      this.users.set(user.id, { ...user });
    }
  }

  async findForLogin(username: string): Promise<UserAuthRecord | null> {
    for (const user of this.users.values()) {
      if (user.username === username) {
        return { ...user };
      }
    }
    return null;
  }

  async findAuthById(userId: string): Promise<UserAuthRecord | null> {
    const user = this.users.get(userId);
    return user ? { ...user } : null;
  }

  async updateSecretsAtomically(input: {
    userId: string;
    expectPasswordHash: string;
    expectWrappedDek: string;
    passwordHash: string;
    wrappedDek: string;
  }): Promise<boolean> {
    const user = this.users.get(input.userId);
    if (!user) {
      return false;
    }
    if (user.passwordHash !== input.expectPasswordHash || user.wrappedDek !== input.expectWrappedDek) {
      return false;
    }
    user.passwordHash = input.passwordHash;
    user.wrappedDek = input.wrappedDek;
    return true;
  }

  async replacePasswordAndDestroyDek(input: {
    userId: string;
    passwordHash: string;
    expectDekVersion: number;
  }): Promise<boolean> {
    const user = this.users.get(input.userId);
    if (!user || user.dekVersion !== input.expectDekVersion) {
      return false;
    }
    user.passwordHash = input.passwordHash;
    user.wrappedDek = null;
    user.dekVersion += 1;
    return true;
  }

  async attachDekIfAbsent(input: {
    userId: string;
    wrappedDek: string;
    expectDekVersion: number;
  }): Promise<boolean> {
    const user = this.users.get(input.userId);
    if (!user || user.wrappedDek !== null || user.dekVersion !== input.expectDekVersion) {
      return false;
    }
    user.wrappedDek = input.wrappedDek;
    return true;
  }

  async touchLastLogin(userId: string, at: Date): Promise<void> {
    this.lastLoginTouched.push({ userId, at });
  }
}

export class FakeCredentialRepository implements ICredentialAdminRepository {
  readonly disabledBatches: Array<{ userId: string; reason: string }> = [];
  /** 每个用户被停用的"凭据"条数，用于断言返回值 */
  constructor(private readonly perUser = 2) {}

  async disableAllForUser(userId: string, reason: string): Promise<number> {
    this.disabledBatches.push({ userId, reason });
    return this.perUser;
  }
}

export class FakeAuditRepository implements IAuditLogRepository {
  readonly rows: AuditLogRow[] = [];
  private seq = 0;

  async append(row: Omit<AuditLogRow, 'id'>): Promise<AuditLogRow> {
    this.seq += 1;
    const full: AuditLogRow = { ...row, id: `audit-${String(this.seq).padStart(3, '0')}` };
    this.rows.push(full);
    return full;
  }

  async lastForTenant(tenantId: string): Promise<Pick<AuditLogRow, 'hash' | 'createdAt'> | null> {
    const filtered = this.rows.filter((row) => row.tenantId === tenantId);
    const last = filtered.at(-1);
    return last ? { hash: last.hash, createdAt: last.createdAt } : null;
  }

  async listForVerify(tenantId: string, limit: number): Promise<AuditLogRow[]> {
    return this.rows
      .filter((row) => row.tenantId === tenantId)
      .slice(0, limit)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  }

  /** 测试辅助：直接篡改某行，模拟"有人在数据库层面动了手" */
  corrupt(index: number, patch: Partial<AuditLogRow>): void {
    const row = this.rows[index];
    if (!row) {
      throw new Error(`没有第 ${index} 行`);
    }
    Object.assign(row, patch);
  }

  removeAt(index: number): void {
    this.rows.splice(index, 1);
  }
}
