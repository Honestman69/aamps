/**
 * 会话查看接口（D043）。**只读**：两个 GET，没有任何写入口。
 *
 * 路由分两段：
 *   - `/api/instances/:instanceId/sessions` 从实例出发看"跟谁聊过"
 *   - `/api/sessions/:sessionId/messages`    从会话出发看"具体说了什么"
 *
 * 不设计成 `/api/instances/:id/sessions/:sid/messages`：前端从左边列表点会话时手里只有
 * sessionId，把 instanceId 也塞进路径等于让前端多维护一条它并不关心的父子关系。
 * 归属校验在服务里按 sessionId 一次做完。
 */

import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';

import { CurrentSession, SessionGuard } from '../auth/session.guard';
import type { SessionRecord } from '../auth/session.service';
import {
  messageListQuerySchema,
  parseOrThrow,
  sessionListQuerySchema,
  type MessagePageDTO,
  type SessionSummaryDTO,
} from './dto';
import { SessionAdminService } from './session-admin.service';

@Controller('api')
@UseGuards(SessionGuard)
export class SessionController {
  constructor(@Inject(SessionAdminService) private readonly sessions: SessionAdminService) {}

  @Get('instances/:instanceId/sessions')
  async list(
    @Param('instanceId') instanceId: string,
    @Query() query: unknown,
    @CurrentSession() session: SessionRecord,
  ): Promise<{ items: SessionSummaryDTO[]; total: number }> {
    const { limit } = parseOrThrow(sessionListQuerySchema, query);
    return this.sessions.listSessions({ userId: session.userId }, instanceId, { limit });
  }

  @Get('sessions/:sessionId/messages')
  async messages(
    @Param('sessionId') sessionId: string,
    @Query() query: unknown,
    @CurrentSession() session: SessionRecord,
  ): Promise<MessagePageDTO> {
    const input = parseOrThrow(messageListQuerySchema, query);
    return this.sessions.listMessages({ userId: session.userId }, sessionId, {
      limit: input.limit,
      ...(input.before ? { before: input.before } : {}),
    });
  }
}
