/**
 * 用户管理：建号、改显示名 / 角色 / 启停。
 *
 * 为什么单独一个服务，而不是塞进 `PasswordService`：
 * 密码那三条路径讲的是"密钥能不能被解开"，这里讲的是"这个人是谁、还能不能用"。
 * 混在一起，迟早出现"停用账号顺手把 Key 废了"这种不可逆的组合。
 *
 * ## 三条必须理解的事
 *
 * 1. **建号不生成 DEK**（SECURITY.md 4.1）：只写 `keySalt`，`wrappedDek` 留空。
 *    DEK 在用户首次登录解锁时才生成并用他自己的密码包裹 —— 建号的一方（哪怕是 superadmin）
 *    因此永远拿不到任何能解开该用户 Key 的材料。
 *
 * 2. **改角色 / 停用必须撤销会话**：`role` 与 `status` 在会话里是**登录时的快照**
 *    （`SessionRecord`），`assertSuperadmin` 读的就是它。不撤销会话的话：
 *      - 把 superadmin 降成 user，他那个会话仍然是 superadmin，继续能读审计、重置别人密码；
 *      - 停用账号，他那个会话照样能改实例、绑 Key。
 *    两者都是"改了配置但没生效"的最坏形态（权限残留）。
 *
 * 3. **停用要清掉内存里的 DEK**：消息主链路按 owner 取 DEK（`RuntimeKeyStore.getForUser`），
 *    不清的话，账号已停用、机器人还在替他说话。清了之后网关抛 `KeyLockedError`，
 *    主链路按 D028 静默处理 —— 表现是"它不说话了"，这是停用该有的样子。
 *    **重新启用不需要做任何事**：`wrappedDek` 还在，用户下次登录用原密码就能解开原 DEK，Key 全部可用。
 *
 * ## 明确不做
 *
 * - **不能停用自己、不能降级自己**：那是把自己锁在门外的唯一方式，且没有第二个管理员时无法恢复。
 *   真要交接，先建一个新 superadmin，用它来停用旧的。
 * - **不做删除用户**：`BotInstance` / `Credential` / `MediaAsset` 都挂在他身上，
 *   删除会级联带走别人（他）的全部数据，且审计里会留下一串指不到人的记录。停用足够。
 * - 停用**不**顺手停用凭据：Key 只是解不开，并不是失效；重新启用后还能用。
 */

import { AppError, BadRequestError, ForbiddenError } from '@newjob/contracts';

import { hashPassword, randomSalt } from '../../common/crypto';
import { AuditAction, AuditService, type AuditActor } from './audit.service';
import { assertPasswordPolicy } from './password.service';
import type {
  IUserAdminMutationRepository,
  IUserAdminQueryRepository,
  IUserProvisionRepository,
  UserAdminDTO,
} from './ports';
import { RuntimeKeyStore } from './runtime-key-store';
import { SessionService } from './session.service';

export type AdminActor = {
  userId: string;
  tenantId: string;
  role: string;
  ip?: string | null;
};

export type CreateUserInput = {
  username: string;
  displayName?: string | null;
  password: string;
  role?: string;
};

export type UpdateUserInput = {
  displayName?: string | null;
  role?: string;
  status?: string;
};

export type UserAdminDeps = {
  users: IUserAdminQueryRepository;
  mutations: IUserAdminMutationRepository;
  provision: IUserProvisionRepository;
  sessions: SessionService;
  keyStore: RuntimeKeyStore;
  audit: AuditService;
};

/** 建号 / 改号的返回：只含展示字段，**永远不含任何密钥材料** */
export type UserMutationResult = {
  id: string;
  username: string;
  role: string;
  status: string;
  /** 改角色/停用时撤销了几个会话（前端用它提示"对面会被踢下线"） */
  revokedSessions: number;
};

export class UserAdminService {
  constructor(private readonly deps: UserAdminDeps) {}

  async create(actor: AdminActor, input: CreateUserInput): Promise<UserMutationResult> {
    const username = input.username.trim();
    assertPasswordPolicy(input.password);

    if (await this.deps.provision.existsByUsername(username)) {
      // 用户名是登录入口，重复即不可用。409 而不是 400：这是"状态冲突"，不是参数写错
      throw new AppError('USERNAME_TAKEN', `用户名「${username}」已存在`, 409);
    }

    const role = input.role ?? 'user';
    if (!isRole(role)) {
      throw new BadRequestError('角色只能是 superadmin 或 user');
    }

    const created = await this.deps.provision.createUser({
      // 租户只能来自操作者自己的会话：请求体里不接受 tenantId（跨租户建号是不该存在的动作）
      tenantId: actor.tenantId,
      username,
      displayName: input.displayName?.trim() || null,
      role,
      passwordHash: await hashPassword(input.password),
      // 16B 随机盐。它只是盐，泄漏了没有密码也解不出 KEK
      keySalt: randomSalt().toString('hex'),
    });

    await this.deps.audit.record({
      tenantId: actor.tenantId,
      actor: auditActor(actor.role),
      actorUserId: actor.userId,
      action: AuditAction.UserCreate,
      target: created.id,
      targetOwnerId: created.id,
      ip: actor.ip ?? null,
      // 只记身份与角色。密码、盐、密文一律不进审计
      after: { username, role, dekInitialized: false },
    });

    return { id: created.id, username, role, status: 'active', revokedSessions: 0 };
  }

  async update(
    actor: AdminActor,
    userId: string,
    input: UpdateUserInput,
  ): Promise<UserMutationResult> {
    const target = await this.deps.users.findForAdmin(userId, actor.tenantId);
    if (!target) {
      // 跨租户与不存在返回同一个 404，防枚举
      throw userNotFound();
    }

    const nextRole = input.role;
    const nextStatus = input.status;

    if (userId === actor.userId) {
      // 把自己锁在门外是最常见的"改配置事故"，而且没有第二个管理员时无法自救
      if (nextStatus === 'disabled') {
        throw new ForbiddenError('不能停用自己的账号：没有第二个管理员时无法恢复');
      }
      if (nextRole && nextRole !== 'superadmin') {
        throw new ForbiddenError('不能降级自己的角色，请先让另一个 superadmin 接手');
      }
    }

    const roleChanged = nextRole !== undefined && nextRole !== target.role;
    const statusChanged = nextStatus !== undefined && nextStatus !== target.status;
    const nextDisplayName =
      input.displayName === undefined ? undefined : input.displayName?.trim() || null;
    const displayNameChanged =
      nextDisplayName !== undefined && nextDisplayName !== target.displayName;

    if (!roleChanged && !statusChanged && !displayNameChanged) {
      // 幂等：重复提交同一份"改动"不该产生第二条审计
      return {
        id: target.id,
        username: target.username,
        role: target.role,
        status: target.status,
        revokedSessions: 0,
      };
    }

    const updated = await this.deps.mutations.updateForAdmin({
      tenantId: actor.tenantId,
      userId,
      ...(displayNameChanged ? { displayName: nextDisplayName as string | null } : {}),
      ...(roleChanged ? { role: nextRole } : {}),
      ...(statusChanged ? { status: nextStatus } : {}),
    });
    if (!updated) {
      throw userNotFound();
    }

    // 角色/状态变了才动会话：改显示名把人踢下线，纯属打扰
    let revokedSessions = 0;
    if (roleChanged || statusChanged) {
      revokedSessions = this.deps.sessions.destroyForUser(userId);
      // 停用还要清内存里的 DEK，否则主链路仍能按 owner 取到它，机器人会继续说话
      if (nextStatus === 'disabled') {
        this.deps.keyStore.clearForUser(userId);
      }
    }

    await this.deps.audit.record({
      tenantId: actor.tenantId,
      actor: auditActor(actor.role),
      actorUserId: actor.userId,
      action: AuditAction.UserUpdate,
      target: target.id,
      targetOwnerId: target.id,
      ip: actor.ip ?? null,
      before: { role: target.role, status: target.status },
      after: {
        role: nextRole ?? target.role,
        status: nextStatus ?? target.status,
        revokedSessions,
      },
    });

    return {
      id: target.id,
      username: target.username,
      role: nextRole ?? target.role,
      status: nextStatus ?? target.status,
      revokedSessions,
    };
  }
}

function userNotFound(): AppError {
  return new AppError('USER_NOT_FOUND', '用户不存在', 404);
}

function isRole(value: string): boolean {
  return value === 'superadmin' || value === 'user';
}

function auditActor(role: string): Extract<AuditActor, 'superadmin' | 'user'> {
  return role === 'superadmin' ? 'superadmin' : 'user';
}

/** 列表转交给查询仓储，顺便把"当前登录者是不是自己"标出来，省得前端再比一次 */
export function markSelf(rows: UserAdminDTO[], selfUserId: string): Array<UserAdminDTO & { isSelf: boolean }> {
  return rows.map((row) => ({ ...row, isSelf: row.id === selfUserId }));
}
