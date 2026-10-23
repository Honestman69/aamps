/**
 * 会话守卫与 `@CurrentSession()`。
 *
 * 守卫只做一件事：把 cookie 验成会话记录，验不过就 401。
 * 权限判断（是不是 superadmin）留在 Controller/Service 里显式写，
 * 不做成"装饰器一加就安全"的隐式行为 —— 那样很容易漏加。
 */

import {
  Injectable,
  createParamDecorator,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { UnauthorizedError } from '@newjob/contracts';
import type { FastifyRequest } from 'fastify';

import {
  SESSION_COOKIE,
  SessionService,
  readCookie,
  type SessionRecord,
} from './session.service';

export const AUTH_SESSION_KEY = 'authSession';

export type AuthedRequest = FastifyRequest & {
  [AUTH_SESSION_KEY]?: SessionRecord;
};

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const raw = readCookie(request.headers.cookie, SESSION_COOKIE);
    const session = this.sessions.verifyCookie(raw);
    if (!session) {
      throw new UnauthorizedError('请先登录');
    }
    request[AUTH_SESSION_KEY] = session;
    return true;
  }
}

export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SessionRecord => {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const session = request[AUTH_SESSION_KEY];
    if (!session) {
      // 理论上不可能：用了这个装饰器就必然挂了守卫
      throw new UnauthorizedError('请先登录');
    }
    return session;
  },
);
