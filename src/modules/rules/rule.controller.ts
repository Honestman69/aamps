/**
 * 约束词接口（D051）。
 *
 * 权限与实例/人设一致：**只能操作自己实例下的约束词**，归属强制取自会话。
 *
 * 红线**不在这里**：它是代码常量，只通过 `GET /api/meta/red-lines` 只读暴露，
 * 不存在任何写入口 —— 包括 superadmin（D020 第 2 条）。
 */

import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';

import { CurrentSession, SessionGuard, type AuthedRequest } from '../auth/session.guard';
import type { SessionRecord } from '../auth/session.service';
import {
  createRuleSchema,
  parseOrThrow,
  ruleIdSchema,
  ruleInstanceIdSchema,
  updateRuleSchema,
  type RuleDTO,
} from './dto';
import { RED_LINES } from './red-lines';
import { RuleService, type RuleActor } from './rule.service';
import { RULE_SERVICE } from './tokens';

function actorOf(session: SessionRecord, request: AuthedRequest): RuleActor {
  return {
    userId: session.userId,
    tenantId: session.tenantId,
    role: session.role,
    ip: request.ip ?? null,
  };
}

@Controller('api')
@UseGuards(SessionGuard)
export class RuleController {
  constructor(@Inject(RULE_SERVICE) private readonly rules: RuleService) {}

  /**
   * 系统红线（只读）。
   *
   * 前端需要它来回答"哪些底线是我改不了的"。放在 `/api/meta` 下是因为它不属于任何实例。
   */
  @Get('meta/red-lines')
  redLines(): { items: Array<{ id: string; text: string }>; editable: boolean } {
    return { items: RED_LINES.map((line) => ({ id: line.id, text: line.text })), editable: false };
  }

  @Get('instances/:instanceId/rules')
  async list(
    @Param('instanceId') instanceId: string,
    @CurrentSession() session: SessionRecord,
    @Req() request: AuthedRequest,
  ): Promise<RuleDTO[]> {
    const id = parseOrThrow(ruleInstanceIdSchema, instanceId);
    return this.rules.list(actorOf(session, request), id);
  }

  @Post('instances/:instanceId/rules')
  async create(
    @Param('instanceId') instanceId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionRecord,
    @Req() request: AuthedRequest,
  ): Promise<RuleDTO> {
    const id = parseOrThrow(ruleInstanceIdSchema, instanceId);
    const input = parseOrThrow(createRuleSchema, body);
    return this.rules.create(actorOf(session, request), id, input);
  }

  @Patch('rules/:id')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionRecord,
    @Req() request: AuthedRequest,
  ): Promise<RuleDTO> {
    const ruleId = parseOrThrow(ruleIdSchema, id);
    const patch = parseOrThrow(updateRuleSchema, body);
    return this.rules.update(actorOf(session, request), ruleId, patch);
  }

  @Delete('rules/:id')
  @HttpCode(200)
  async remove(
    @Param('id') id: string,
    @CurrentSession() session: SessionRecord,
    @Req() request: AuthedRequest,
  ): Promise<{ removed: true }> {
    const ruleId = parseOrThrow(ruleIdSchema, id);
    await this.rules.remove(actorOf(session, request), ruleId);
    return { removed: true };
  }
}
