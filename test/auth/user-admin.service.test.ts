/**
 * 用户管理（D042）：建号 / 改角色 / 启停。
 *
 * 这组用例盯的是"改完到底生效没有"，而不是返回值好不好看：
 *   - 建号是否**只写盐、不生成 DEK**（否则管理员就能解别人的 Key）
 *   - 停用是否真的把会话与内存 DEK 都撤掉（否则账号停了、机器人还在替他说话）
 *   - 改角色是否踢掉旧会话（`role` 在会话里是登录时的快照，不踢就权限残留）
 *   - 是否拦住了"停用自己 / 降级自己"
 */

import { randomDek } from '@/common/crypto';
import { AuditAction, AuditService } from '@/modules/auth/audit.service';
import type {
  IUserAdminMutationRepository,
  IUserAdminQueryRepository,
  IUserProvisionRepository,
  UserAdminDTO,
} from '@/modules/auth/ports';
import { RuntimeKeyStore } from '@/modules/auth/runtime-key-store';
import { SessionService } from '@/modules/auth/session.service';
import { UserAdminService } from '@/modules/auth/user-admin.service';
import { describe, expect, it } from 'vitest';

import { FakeAuditRepository } from '../helpers/auth-fakes';

const TENANT = 'tenant-1';
const SES_SECRET = 'x'.repeat(48);

type Stored = {
  id: string;
  tenantId: string;
  username: string;
  displayName: string | null;
  role: string;
  status: string;
  passwordHash: string;
  keySalt: string;
  dekVersion: number;
  lastLoginAt: Date | null;
  createdAt: Date;
};

class FakeUsers implements IUserAdminQueryRepository, IUserAdminMutationRepository, IUserProvisionRepository {
  readonly rows = new Map<string, Stored>();
  private seq = 0;

  seed(input: Partial<Stored> & { username: string }): Stored {
    this.seq += 1;
    const row: Stored = {
      id: `user-${this.seq}`,
      tenantId: TENANT,
      displayName: null,
      role: 'user',
      status: 'active',
      passwordHash: 'hash-placeholder',
      keySalt: 'a'.repeat(32),
      dekVersion: 1,
      lastLoginAt: null,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      ...input,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async listForAdmin(tenantId: string): Promise<UserAdminDTO[]> {
    return [...this.rows.values()]
      .filter((row) => row.tenantId === tenantId)
      .map((row) => ({
        id: row.id,
        username: row.username,
        displayName: row.displayName,
        role: row.role,
        status: row.status,
        dekInitialized: false,
        dekVersion: row.dekVersion,
        lastLoginAt: null,
        createdAt: row.createdAt.toISOString(),
      }));
  }

  async findForAdmin(userId: string, tenantId: string) {
    const row = this.rows.get(userId);
    if (!row || row.tenantId !== tenantId) {
      return null;
    }
    return {
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      role: row.role,
      status: row.status,
    };
  }

  async updateForAdmin(input: {
    tenantId: string;
    userId: string;
    displayName?: string | null;
    role?: string;
    status?: string;
  }): Promise<boolean> {
    const row = this.rows.get(input.userId);
    if (!row || row.tenantId !== input.tenantId) {
      return false;
    }
    if (input.displayName !== undefined) row.displayName = input.displayName;
    if (input.role !== undefined) row.role = input.role;
    if (input.status !== undefined) row.status = input.status;
    return true;
  }

  async existsByUsername(username: string): Promise<boolean> {
    return [...this.rows.values()].some((row) => row.username === username);
  }

  async createUser(input: {
    tenantId: string;
    username: string;
    displayName?: string | null;
    role: string;
    passwordHash: string;
    keySalt: string;
  }): Promise<{ id: string }> {
    const row = this.seed({
      username: input.username,
      tenantId: input.tenantId,
      displayName: input.displayName ?? null,
      role: input.role,
      passwordHash: input.passwordHash,
      keySalt: input.keySalt,
    });
    return { id: row.id };
  }
}

function setup() {
  const users = new FakeUsers();
  const auditRepo = new FakeAuditRepository();
  const sessions = new SessionService(SES_SECRET);
  const keyStore = new RuntimeKeyStore();

  const service = new UserAdminService({
    users,
    mutations: users,
    provision: users,
    sessions,
    keyStore,
    audit: new AuditService(auditRepo),
  });

  const actions = (): string[] => auditRepo.rows.map((row) => row.action);

  return { users, service, sessions, keyStore, auditRepo, actions };
}

const ADMIN = { userId: 'admin-1', tenantId: TENANT, role: 'superadmin', ip: '127.0.0.1' };

describe('建号', () => {
  it('默认角色是 user，并只写盐（不生成 DEK）', async () => {
    const { users, service, actions } = setup();

    const result = await service.create(ADMIN, {
      username: 'alice',
      password: 'correct-horse-battery',
    });

    expect(result.role).toBe('user');
    expect(result.status).toBe('active');

    const stored = users.rows.get(result.id)!;
    // 16 字节 → 32 个 hex 字符
    expect(stored.keySalt).toMatch(/^[0-9a-f]{32}$/);
    // 建号方不该有任何能解开对方 Key 的材料
    expect(stored.passwordHash).not.toContain('correct-horse-battery');
    expect(actions()).toEqual([AuditAction.UserCreate]);
  });

  it('可以建第二个 superadmin（唯一管理员被锁死时要有救）', async () => {
    const { service } = setup();
    const result = await service.create(ADMIN, {
      username: 'backup-admin',
      password: 'correct-horse-battery',
      role: 'superadmin',
    });
    expect(result.role).toBe('superadmin');
  });

  it('用户名重复 → 409', async () => {
    const { users, service } = setup();
    users.seed({ username: 'alice' });

    await expect(
      service.create(ADMIN, { username: 'alice', password: 'correct-horse-battery' }),
    ).rejects.toMatchObject({ code: 'USERNAME_TAKEN', httpStatus: 409 });
  });

  it('密码太短 → 400（与改密/重置共用同一条强度规则）', async () => {
    const { service } = setup();
    await expect(service.create(ADMIN, { username: 'bob', password: 'short' })).rejects.toThrow(
      /密码至少 12 位/,
    );
  });

  it('租户来自操作者，不接受请求体（跨租户建号不该存在）', async () => {
    const { users, service } = setup();
    const result = await service.create(ADMIN, {
      username: 'carol',
      password: 'correct-horse-battery',
    });
    expect(users.rows.get(result.id)!.tenantId).toBe(TENANT);
  });
});

describe('改角色 / 启停', () => {
  it('改显示名：不踢会话（改个名字把人踢下线纯属打扰）', async () => {
    const { users, service, sessions } = setup();
    const alice = users.seed({ username: 'alice' });
    const session = sessions.create({ userId: alice.id, tenantId: TENANT, role: 'user' }, 60_000);

    const result = await service.update(ADMIN, alice.id, { displayName: '爱丽丝' });

    expect(result.revokedSessions).toBe(0);
    expect(users.rows.get(alice.id)!.displayName).toBe('爱丽丝');
    // 会话仍然有效
    expect(sessions.verifyCookie(sessions.signCookie(session.id))).not.toBeNull();
  });

  it('停用：撤销全部会话并清掉内存 DEK', async () => {
    const { users, service, sessions, keyStore, actions } = setup();
    const alice = users.seed({ username: 'alice' });
    const session = sessions.create({ userId: alice.id, tenantId: TENANT, role: 'user' }, 60_000);
    keyStore.set(session.id, alice.id, randomDek());

    const result = await service.update(ADMIN, alice.id, { status: 'disabled' });

    expect(result.status).toBe('disabled');
    expect(result.revokedSessions).toBe(1);
    // 会话没了：再用旧 cookie 验不过
    expect(sessions.verifyCookie(sessions.signCookie(session.id))).toBeNull();
    // DEK 也没了：消息主链路按 owner 取不到它，机器人不会再替他说话
    expect(() => keyStore.getForUser(alice.id)).toThrow();
    expect(actions()).toEqual([AuditAction.UserUpdate]);
  });

  it('改角色：必须踢会话（role 是登录时的快照，不踢就是权限残留）', async () => {
    const { users, service, sessions } = setup();
    const boss = users.seed({ username: 'boss', role: 'superadmin' });
    const session = sessions.create({ userId: boss.id, tenantId: TENANT, role: 'superadmin' }, 60_000);

    const result = await service.update(ADMIN, boss.id, { role: 'user' });

    expect(result.revokedSessions).toBe(1);
    expect(sessions.verifyCookie(sessions.signCookie(session.id))).toBeNull();
    expect(users.rows.get(boss.id)!.role).toBe('user');
  });

  it('不能停用自己 / 不能降级自己', async () => {
    const { users, service } = setup();
    // 自己也得在库里，否则先撞 404（那是对的：连目标都查不到就不该继续判断）
    users.seed({ id: ADMIN.userId, username: 'root-admin', role: 'superadmin' });
    await expect(service.update(ADMIN, ADMIN.userId, { status: 'disabled' })).rejects.toThrow(
      /不能停用自己/,
    );
    await expect(service.update(ADMIN, ADMIN.userId, { role: 'user' })).rejects.toThrow(
      /不能降级自己/,
    );
  });

  it('不存在的用户 / 别的租户 → 404', async () => {
    const { users, service } = setup();
    const outsider = users.seed({ username: 'outsider', tenantId: 'tenant-2' });

    await expect(service.update(ADMIN, 'no-such-user', { status: 'disabled' })).rejects.toMatchObject(
      { code: 'USER_NOT_FOUND', httpStatus: 404 },
    );
    await expect(service.update(ADMIN, outsider.id, { status: 'disabled' })).rejects.toMatchObject({
      code: 'USER_NOT_FOUND',
    });
  });

  it('幂等：重复提交同样的值不产生第二条审计', async () => {
    const { users, service, actions } = setup();
    const alice = users.seed({ username: 'alice', status: 'disabled' });

    const result = await service.update(ADMIN, alice.id, { status: 'disabled' });

    expect(result.revokedSessions).toBe(0);
    expect(actions()).toEqual([]);
  });
});
