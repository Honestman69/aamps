/**
 * Prisma 仓储实现。
 *
 * 三条纪律（违反即返工）：
 *   1. **CAS 用一条 SQL 完成**（`updateMany` + where 带旧值），不要"先读再判断再写"——
 *      那样在两个并发请求之间就有空隙。
 *   2. 认证查询只 select 需要的字段，绝不 `include: { credentials: true }` 顺手带出密文。
 *   3. 审计仓储**没有** update / delete 方法（D009），连方法名都不出现。
 */

import type { PrismaClient } from '@prisma/client';

import type { AuditLogRow } from '../audit.service';
import type {
  IAuditLogRepository,
  ICredentialAdminRepository,
  IUserAdminMutationRepository,
  IUserAdminQueryRepository,
  IUserAuthRepository,
  UserAdminDTO,
  UserAuthRecord,
} from '../ports';

/** 认证需要的最小字段集。不含 createdAt / lastLoginAt 等展示字段，避免无意义的数据流动 */
const AUTH_SELECT = {
  id: true,
  tenantId: true,
  username: true,
  role: true,
  status: true,
  passwordHash: true,
  keySalt: true,
  wrappedDek: true,
  dekVersion: true,
} as const;

export class PrismaUserAuthRepository implements IUserAuthRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findForLogin(username: string): Promise<UserAuthRecord | null> {
    return this.prisma.user.findUnique({ where: { username }, select: AUTH_SELECT });
  }

  async findAuthById(userId: string): Promise<UserAuthRecord | null> {
    return this.prisma.user.findUnique({ where: { id: userId }, select: AUTH_SELECT });
  }

  async updateSecretsAtomically(input: {
    userId: string;
    expectPasswordHash: string;
    expectWrappedDek: string;
    passwordHash: string;
    wrappedDek: string;
  }): Promise<boolean> {
    const { count } = await this.prisma.user.updateMany({
      where: {
        id: input.userId,
        passwordHash: input.expectPasswordHash,
        wrappedDek: input.expectWrappedDek,
      },
      data: {
        passwordHash: input.passwordHash,
        wrappedDek: input.wrappedDek,
      },
    });
    return count === 1;
  }

  async replacePasswordAndDestroyDek(input: {
    userId: string;
    passwordHash: string;
    expectDekVersion: number;
  }): Promise<boolean> {
    const { count } = await this.prisma.user.updateMany({
      where: { id: input.userId, dekVersion: input.expectDekVersion },
      data: {
        passwordHash: input.passwordHash,
        wrappedDek: null,
        dekVersion: { increment: 1 },
      },
    });
    return count === 1;
  }

  async attachDekIfAbsent(input: {
    userId: string;
    wrappedDek: string;
    expectDekVersion: number;
  }): Promise<boolean> {
    const { count } = await this.prisma.user.updateMany({
      where: { id: input.userId, wrappedDek: null, dekVersion: input.expectDekVersion },
      data: { wrappedDek: input.wrappedDek },
    });
    return count === 1;
  }

  async touchLastLogin(userId: string, at: Date): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { lastLoginAt: at } });
  }

  /** 是否已存在该用户名（种子脚本用，不返回密码材料） */
  async existsByUsername(username: string): Promise<boolean> {
    const found = await this.prisma.user.findUnique({ where: { username }, select: { id: true } });
    return found !== null;
  }

  /** 建用户：只写 keySalt，**不生成 DEK**（DEK 在首次登录解锁时才生成，见 SECURITY.md 4.1） */
  async createUser(input: {
    tenantId: string;
    username: string;
    displayName?: string | null;
    role: string;
    passwordHash: string;
    keySalt: string;
  }): Promise<{ id: string }> {
    return this.prisma.user.create({
      data: {
        tenantId: input.tenantId,
        username: input.username,
        displayName: input.displayName ?? null,
        role: input.role,
        passwordHash: input.passwordHash,
        keySalt: input.keySalt,
      },
      select: { id: true },
    });
  }
}

export class PrismaCredentialAdminRepository implements ICredentialAdminRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** 只按 ownerUserId 精确停用，不存在"全表扫一遍再过滤"的写法 */
  async disableAllForUser(userId: string, reason: string): Promise<number> {
    const { count } = await this.prisma.credential.updateMany({
      where: { ownerUserId: userId, enabled: true },
      data: { enabled: false, disabledBy: 'system', lastError: reason },
    });
    return count;
  }
}

export class PrismaAuditLogRepository implements IAuditLogRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async append(row: Omit<AuditLogRow, 'id'>): Promise<AuditLogRow> {
    return this.prisma.auditLog.create({ data: row });
  }

  async lastForTenant(tenantId: string): Promise<Pick<AuditLogRow, 'hash' | 'createdAt'> | null> {
    return this.prisma.auditLog.findFirst({
      where: { tenantId },
      // createdAt 已被 AuditService 保证严格递增，这里按时间取最后一条即可
      orderBy: { createdAt: 'desc' },
      select: { hash: true, createdAt: true },
    });
  }

  async listForVerify(tenantId: string, limit: number): Promise<AuditLogRow[]> {
    return this.prisma.auditLog.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  async listRecent(tenantId: string, limit: number): Promise<AuditLogRow[]> {
    return this.prisma.auditLog.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}

/**
 * 管理端用户查询。
 *
 * 唯一一处 select 里出现 `wrappedDek` 的地方，而且**只是为了算一个布尔**
 * （`dekInitialized`），密文本身绝不进入返回值。类型 `UserAdminDTO` 里也没有它。
 */
export class PrismaUserAdminQueryRepository implements IUserAdminQueryRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listForAdmin(tenantId: string): Promise<UserAdminDTO[]> {
    const rows = await this.prisma.user.findMany({
      where: { tenantId },
      select: {
        id: true,
        username: true,
        displayName: true,
        role: true,
        status: true,
        wrappedDek: true,
        dekVersion: true,
        lastLoginAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      role: row.role,
      status: row.status,
      dekInitialized: row.wrappedDek !== null,
      dekVersion: row.dekVersion,
      lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async findForAdmin(
    userId: string,
    tenantId: string,
  ): Promise<{
    id: string;
    username: string;
    displayName: string | null;
    role: string;
    status: string;
  } | null> {
    // 带 tenantId 一起查：跨租户一律查不到，不靠上层再判断
    return this.prisma.user.findFirst({
      where: { id: userId, tenantId },
      select: { id: true, username: true, displayName: true, role: true, status: true },
    });
  }
}

/**
 * 管理端写：改显示名 / 角色 / 启停。
 *
 * 用 `updateMany` 而不是 `update`：`update` 只能按唯一键定位，`where` 里塞不进 tenantId，
 * 就得先查一次再更新（TOCTOU 窗口）。`updateMany` 的 where 天然带租户条件，
 * 返回 `count` 即可判断"改了还是没改" —— 跨租户只会得到 0。
 */
export class PrismaUserAdminMutationRepository implements IUserAdminMutationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async updateForAdmin(input: {
    tenantId: string;
    userId: string;
    displayName?: string | null;
    role?: string;
    status?: string;
  }): Promise<boolean> {
    const { count } = await this.prisma.user.updateMany({
      where: { id: input.userId, tenantId: input.tenantId },
      data: {
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
    });
    return count > 0;
  }
}
