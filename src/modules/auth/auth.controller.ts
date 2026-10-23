/**
 * 认证接口。
 *
 * 设计要点：
 *   1. **登录即解锁**：一个动作完成"验密码 + 解出 DEK"，否则用户要连做两次密码输入。
 *      代价是登录响应稍慢（一次 Argon2），可接受。
 *   2. cookie 里只有签名后的 sessionId，**没有任何用户身份或密钥材料**。
 *   3. 改密只踢掉**其他**设备，当前会话保留（DEK 没变，没必要把自己踢下线）。
 *   4. 所有密码类接口都不回显任何密文/明文，响应体里只有状态。
 */

import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ForbiddenError, UnauthorizedError } from '@newjob/contracts';
import type { FastifyReply } from 'fastify';

import { intEnv, isProduction } from '../../common/config/env';
import { PasswordService } from './password.service';
import { changePasswordSchema, loginSchema, unlockSchema, parseOrThrow } from './dto';
import type { IUserAuthRepository } from './ports';
import { DEFAULT_UNLOCK_TTL_MS, RuntimeKeyStore } from './runtime-key-store';
import { SessionService, buildSessionCookie } from './session.service';
import { CurrentSession, SessionGuard, type AuthedRequest } from './session.guard';
import { USER_AUTH_REPOSITORY } from './tokens';
import { UnlockService } from './unlock.service';

function sessionTtlMs(): number {
  const hours = intEnv('SESSION_TTL_HOURS', 168);
  return hours > 0 ? hours * 60 * 60 * 1000 : DEFAULT_UNLOCK_TTL_MS;
}

function clientIp(request: AuthedRequest): string | null {
  // 自用部署默认不信任代理头，直接取连接地址；配了反代再改这里
  return request.ip ?? null;
}

@Controller('api/auth')
export class AuthController {
  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(UnlockService) private readonly unlockService: UnlockService,
    @Inject(PasswordService) private readonly passwordService: PasswordService,
    @Inject(RuntimeKeyStore) private readonly keyStore: RuntimeKeyStore,
    @Inject(USER_AUTH_REPOSITORY) private readonly users: IUserAuthRepository,
  ) {}

  /** 登出/锁定后统一清 cookie，避免浏览器继续带垃圾值 */
  private clearCookie(reply: FastifyReply): void {
    reply.header('Set-Cookie', buildSessionCookie('', 0, isProduction()));
  }

  private setCookie(reply: FastifyReply, sessionId: string): void {
    const maxAgeSeconds = Math.floor(sessionTtlMs() / 1000);
    reply.header('Set-Cookie', buildSessionCookie(this.sessions.signCookie(sessionId), maxAgeSeconds, isProduction()));
  }

  /**
   * 登录 = 验密码 + 解锁。
   * 用户名不存在与密码错误返回同一句话（防枚举）。
   */
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() request: AuthedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{
    user: { id: string; username: string; role: string };
    unlocked: boolean;
    unlockExpiresAt: string;
  }> {
    const input = parseOrThrow(loginSchema, body);
    const record = await this.users.findForLogin(input.username);
    if (!record || record.status !== 'active') {
      throw new UnauthorizedError('用户名或密码错误');
    }

    const ttlMs = sessionTtlMs();
    // 先建会话：DEK 是按 sessionId 存的，解锁必须先有会话 id
    const session = this.sessions.create(
      { userId: record.id, tenantId: record.tenantId, role: record.role },
      ttlMs,
    );

    try {
      await this.unlockService.unlock({
        sessionId: session.id,
        userId: record.id,
        password: input.password,
        ttlMs,
        ip: clientIp(request),
      });
    } catch (err) {
      // 密码错误时不留下半成品会话
      this.sessions.destroy(session.id);
      throw err;
    }

    this.setCookie(reply, session.id);
    const state = this.keyStore.getState(session.id);

    return {
      user: { id: record.id, username: record.username, role: record.role },
      unlocked: true,
      unlockExpiresAt: (state?.expiresAt ?? session.expiresAt).toISOString(),
    };
  }

  /** 重新解锁（服务重启或会话过期后） */
  @Post('unlock')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async unlock(
    @Body() body: unknown,
    @CurrentSession() session: { id: string; userId: string },
    @Req() request: AuthedRequest,
  ): Promise<{ unlocked: boolean; expiresAt: string }> {
    const input = parseOrThrow(unlockSchema, body);
    const result = await this.unlockService.unlock({
      sessionId: session.id,
      userId: session.userId,
      password: input.password,
      ttlMs: sessionTtlMs(),
      ip: clientIp(request),
    });
    return { unlocked: true, expiresAt: result.expiresAt.toISOString() };
  }

  /** 主动锁定：清掉内存 DEK 并销毁会话 */
  @Post('lock')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async lock(
    @CurrentSession() session: { id: string; userId: string },
    @Req() request: AuthedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ unlocked: boolean }> {
    await this.unlockService.lock({ sessionId: session.id, userId: session.userId, ip: clientIp(request) });
    this.sessions.destroy(session.id);
    this.clearCookie(reply);
    return { unlocked: false };
  }

  /** 当前状态：只有身份与解锁状态，**不含任何密钥相关信息** */
  @Get('me')
  @UseGuards(SessionGuard)
  async me(@CurrentSession() session: { id: string; userId: string; role: string }): Promise<{
    user: { id: string; role: string; username: string | null };
    unlocked: boolean;
    unlockExpiresAt: string | null;
  }> {
    const record = await this.users.findAuthById(session.userId);
    // 会话有效但用户已被删除/停用：立刻拒绝，不要拿旧会话继续用
    if (!record || record.status !== 'active') {
      throw new UnauthorizedError('会话已失效，请重新登录');
    }
    const state = this.keyStore.getState(session.id);
    return {
      user: { id: record.id, role: record.role, username: record.username },
      unlocked: state !== null,
      unlockExpiresAt: state?.expiresAt.toISOString() ?? null,
    };
  }

  /** 本人改密码：Key 不受影响（D004 路径 A） */
  @Post('password')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async changePassword(
    @Body() body: unknown,
    @CurrentSession() session: { id: string; userId: string; role: string },
    @Req() request: AuthedRequest,
  ): Promise<{ ok: true }> {
    const input = parseOrThrow(changePasswordSchema, body);
    await this.passwordService.changePassword({
      sessionId: session.id,
      userId: session.userId,
      oldPassword: input.oldPassword,
      newPassword: input.newPassword,
      ip: clientIp(request),
      ttlMs: sessionTtlMs(),
    });
    // 其他设备下线，当前会话保留
    this.sessions.destroyOthersForUser(session.userId, session.id);
    return { ok: true };
  }
}
