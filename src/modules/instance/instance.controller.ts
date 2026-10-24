/**
 * 实例接口：后台"输入 QQ 号 / 切换账号"就落在这些路由上。
 *
 * 与凭据接口同样的权限模型：**只能操作自己的**。路径里没有 userId，
 * 归属强制取自会话，所以不存在"改个参数就能连别人的号"。
 *
 * 连接与断开是独立动作，不走 PATCH —— 它们会触发真实的网络连接与 token 解密，
 * 与"改个名字"完全不是一个量级的事，混在一起以后没法做二次确认。
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { CurrentSession, SessionGuard, type AuthedRequest } from '../auth/session.guard';
import type { SessionRecord } from '../auth/session.service';
import {
  createInstanceSchema,
  instanceIdSchema,
  parseOrThrow,
  updateInstanceSchema,
  type InstancePublicDTO,
} from './dto';
import { InstanceService, type InstanceActor } from './instance.service';
import { INSTANCE_SERVICE } from './tokens';

function actorOf(session: SessionRecord, request: AuthedRequest): InstanceActor {
  return {
    sessionId: session.id,
    userId: session.userId,
    tenantId: session.tenantId,
    role: session.role,
    ip: request.ip ?? null,
  };
}

@Controller('api/instances')
@UseGuards(SessionGuard)
export class InstanceController {
  constructor(@Inject(INSTANCE_SERVICE) private readonly instances: InstanceService) {}

  @Get()
  async list(@CurrentSession() session: SessionRecord): Promise<InstancePublicDTO[]> {
    return this.instances.list({ userId: session.userId });
  }

  @Post()
  async create(
    @Body() body: unknown,
    @CurrentSession() session: SessionRecord,
    @Req() request: AuthedRequest,
  ): Promise<InstancePublicDTO> {
    const input = parseOrThrow(createInstanceSchema, body);
    return this.instances.create(actorOf(session, request), input);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionRecord,
    @Req() request: AuthedRequest,
  ): Promise<InstancePublicDTO> {
    const instanceId = parseOrThrow(instanceIdSchema, id);
    const input = parseOrThrow(updateInstanceSchema, body);
    return this.instances.update(actorOf(session, request), instanceId, input);
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(
    @Param('id') id: string,
    @CurrentSession() session: SessionRecord,
    @Req() request: AuthedRequest,
  ): Promise<{ deleted: true }> {
    const instanceId = parseOrThrow(instanceIdSchema, id);
    return this.instances.remove(actorOf(session, request), instanceId);
  }

  /** 连接。未解锁返回 401 KEY_LOCKED；NapCat 没起来返回 502 */
  @Post(':id/connect')
  @HttpCode(200)
  async connect(
    @Param('id') id: string,
    @CurrentSession() session: SessionRecord,
    @Req() request: AuthedRequest,
  ): Promise<{ status: string; accountId: string; platform: string }> {
    const instanceId = parseOrThrow(instanceIdSchema, id);
    return this.instances.connect(actorOf(session, request), instanceId);
  }

  @Post(':id/disconnect')
  @HttpCode(200)
  async disconnect(
    @Param('id') id: string,
    @CurrentSession() session: SessionRecord,
    @Req() request: AuthedRequest,
  ): Promise<{ status: string }> {
    const instanceId = parseOrThrow(instanceIdSchema, id);
    return this.instances.disconnect(actorOf(session, request), instanceId);
  }
}
