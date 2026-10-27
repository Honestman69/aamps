/**
 * 管理端：用户列表 / 建号 / 改角色与启停 / 重置密码 / 审计查询。
 *
 * 判定依据（D004 / SECURITY.md 5.1）：
 *   **操作者 ≠ 目标用户** 才允许重置。superadmin 改自己的密码也必须走 `/api/auth/password`。
 *   这条不靠角色判断，所以即使 superadmin 也不会因为"权限大"而绕过销毁语义。
 *
 * 所有响应体都经过 DTO 收窄：没有 `wrappedDek`、没有 `keySalt`、没有 `apiKeyEnc`。
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ForbiddenError } from '@newjob/contracts';

import { AuditService } from './audit.service';
import {
  auditQuerySchema,
  createUserSchema,
  parseOrThrow,
  resetPasswordSchema,
  updateUserSchema,
} from './dto';
import { PasswordService } from './password.service';
import type { IUserAdminQueryRepository } from './ports';
import { ADMIN_USER_REPOSITORY } from './tokens';
import { CurrentSession, SessionGuard, type AuthedRequest } from './session.guard';
import { markSelf, UserAdminService, type UserMutationResult } from './user-admin.service';

export const AUDIT_SERVICE = 'AUDIT_SERVICE';

type Session = { id: string; userId: string; tenantId: string; role: string };

function actorOf(session: Session, request: AuthedRequest): {
  userId: string;
  tenantId: string;
  role: string;
  ip: string | null;
} {
  return {
    userId: session.userId,
    tenantId: session.tenantId,
    role: session.role,
    // 审计要记来源 IP，但不记 UA（隐私，且对排查没帮助）
    ip: request.ip ?? null,
  };
}

function assertSuperadmin(session: Session): void {
  if (session.role !== 'superadmin') {
    // 不区分"不是管理员"和"资源不存在"，防枚举
    throw new ForbiddenError('无权访问');
  }
}

@Controller('api/admin')
@UseGuards(SessionGuard)
export class AdminController {
  constructor(
    @Inject(PasswordService) private readonly passwordService: PasswordService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(ADMIN_USER_REPOSITORY) private readonly users: IUserAdminQueryRepository,
    @Inject(UserAdminService) private readonly userAdmin: UserAdminService,
  ) {}

  /**
   * 建号。
   *
   * 建出来的账号 `wrappedDek = null`：DEK 由用户首次登录时用他自己的密码生成并包裹，
   * 所以管理员**拿不到**对方的 Key 材料（SECURITY.md 4.1）。
   */
  @Post('users')
  async createUser(
    @Body() body: unknown,
    @CurrentSession() session: Session,
    @Req() request: AuthedRequest,
  ): Promise<UserMutationResult> {
    assertSuperadmin(session);
    const input = parseOrThrow(createUserSchema, body);
    return this.userAdmin.create(actorOf(session, request), input);
  }

  /** 改显示名 / 角色 / 启停。改角色或停用会撤销对方的全部会话 */
  @Patch('users/:id')
  @HttpCode(200)
  async updateUser(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentSession() session: Session,
    @Req() request: AuthedRequest,
  ): Promise<UserMutationResult> {
    assertSuperadmin(session);
    const input = parseOrThrow(updateUserSchema, body);
    return this.userAdmin.update(actorOf(session, request), id, input);
  }

  /** 用户列表。刻意只有脱敏字段（`dekInitialized` 是布尔，不是密文） */
  @Get('users')
  async listUsers(@CurrentSession() session: Session): Promise<unknown> {
    assertSuperadmin(session);
    const rows = await this.users.listForAdmin(session.tenantId);
    // 带上 isSelf：前端据此禁用"停用/降级自己"的按钮，而不是等后端 403 才知道
    return markSelf(rows, session.userId);
  }

  /** 管理员重置他人密码：销毁 wrappedDek，该用户全部 Key 报废 */
  @Post('users/:id/reset-password')
  @HttpCode(200)
  async resetPassword(
    @Param('id') targetUserId: string,
    @Body() body: unknown,
    @CurrentSession() session: Session,
    @Req() request: AuthedRequest,
  ): Promise<{ ok: true; disabledCredentials: number; clearedSessions: number }> {
    assertSuperadmin(session);
    const input = parseOrThrow(resetPasswordSchema, body);

    if (targetUserId === session.userId) {
      throw new ForbiddenError('本人修改密码请使用 /api/auth/password，重置会销毁全部密钥');
    }

    const target = await this.users.findForAdmin(targetUserId, session.tenantId);
    if (!target) {
      // 不区分"不存在"和"不是你的租户"
      throw new ForbiddenError('无权操作该账号');
    }
    // 二次确认：必须输入目标用户名，防止手滑点错人
    if (target.username !== input.confirmUsername) {
      throw new ForbiddenError('确认用户名不匹配');
    }

    const result = await this.passwordService.resetPassword({
      actorUserId: session.userId,
      actor: 'superadmin',
      targetUserId,
      newPassword: input.newPassword,
      ip: request.ip ?? null,
    });

    return {
      ok: true,
      disabledCredentials: result.disabledCredentials,
      clearedSessions: result.clearedSessions,
    };
  }

  /** 审计查询（返回体已脱敏，不含任何密钥材料） */
  @Get('audit')
  async listAudit(@CurrentSession() session: Session, @Query() query: unknown): Promise<unknown> {
    assertSuperadmin(session);
    const { limit } = parseOrThrow(auditQuerySchema, query);
    const rows = await this.audit.listRecent(session.tenantId, limit);
    return rows.map((row) => ({
      id: row.id,
      actor: row.actor,
      actorUserId: row.actorUserId,
      action: row.action,
      target: row.target,
      targetOwnerId: row.targetOwnerId,
      ip: row.ip,
      before: row.beforeJson ? JSON.parse(row.beforeJson) : null,
      after: row.afterJson ? JSON.parse(row.afterJson) : null,
      prevHash: row.prevHash,
      hash: row.hash,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /** 哈希链完整性校验：能报出断在第几条 */
  @Post('audit/verify')
  @HttpCode(200)
  async verifyAudit(@CurrentSession() session: Session): Promise<unknown> {
    assertSuperadmin(session);
    return this.audit.verifyTenant(session.tenantId);
  }
}
