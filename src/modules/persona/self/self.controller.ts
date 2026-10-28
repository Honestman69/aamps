/**
 * 人格演化的只读接口 + 回滚（M5-2）。
 *
 * **没有"手工改自述 / 手工调特质"的接口** —— 这是刻意的（D046）：
 * 手改等于绕过闸门，一次就能把"慢慢变成另一个人"变成"立刻变成另一个人"，
 * 而那正是 D020 的四层结构要防的事。
 *
 * 但"看到它变成了什么样"和"退回去"必须能点：前者是知情权，后者是纠错权。
 * 回滚不是删除历史，而是**追加一版**等于旧内容的新版本（版本号继续 +1）。
 */

import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';

import { CurrentSession, SessionGuard, type AuthedRequest } from '../../auth/session.guard';
import type { SessionRecord } from '../../auth/session.service';
import { instanceIdSchema, parseOrThrow } from '../dto';
import { rollbackSchema, versionQuerySchema } from './dto';
import {
  SelfStateService,
  type SelfActor,
  type SelfStateView,
  type SelfVersionView,
} from './self-state.service';
import { SELF_STATE_SERVICE } from '../tokens';

function actorOf(session: SessionRecord, request: AuthedRequest): SelfActor {
  return {
    userId: session.userId,
    tenantId: session.tenantId,
    role: session.role,
    ip: request.ip ?? null,
  };
}

@Controller('api')
@UseGuards(SessionGuard)
export class SelfController {
  constructor(@Inject(SELF_STATE_SERVICE) private readonly self: SelfStateService) {}

  /** 现在的自己 + 版本历史（界面按这个页看"它是怎么一步步变的"） */
  @Get('instances/:instanceId/self')
  async read(
    @Param('instanceId') instanceId: string,
    @Query() query: unknown,
    @CurrentSession() session: SessionRecord,
    @Req() request: AuthedRequest,
  ): Promise<{ state: SelfStateView; versions: SelfVersionView[] }> {
    const id = parseOrThrow(instanceIdSchema, instanceId);
    const { limit } = parseOrThrow(versionQuerySchema, query);
    const actor = actorOf(session, request);
    // 先读版本（顺带做归属校验），再读当前状态
    const versions = await this.self.listVersions(actor, id, limit);
    return { state: await this.self.load(id), versions };
  }

  /** 回滚到某一版：追加一版新版本，历史不删 */
  @Post('instances/:instanceId/self/rollback')
  @HttpCode(200)
  async rollback(
    @Param('instanceId') instanceId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionRecord,
    @Req() request: AuthedRequest,
  ): Promise<{ state: SelfStateView; createdVersion: number }> {
    const id = parseOrThrow(instanceIdSchema, instanceId);
    const { version } = parseOrThrow(rollbackSchema, body);
    return this.self.rollback(actorOf(session, request), id, version);
  }
}
