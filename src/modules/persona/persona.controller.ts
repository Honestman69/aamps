/**
 * 人设接口：M4 人设编辑器的后台入口。
 *
 * 权限模型与实例/凭据一致：**只能操作自己实例下的人设**。
 * 路径里没有 userId，归属强制取自会话。
 *
 * 发布 / 归档 / 启用是独立动作，不走 PATCH：
 * 它们改变的是"线上生效的是哪一份"，与"改个词"不是一个量级，混在一起以后没法加二次确认。
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

import { CurrentSession, SessionGuard, type AuthedRequest } from '../auth/session.guard';
import type { SessionRecord } from '../auth/session.service';
import {
  createPersonaSchema,
  instanceIdSchema,
  listPersonasQuerySchema,
  parseOrThrow,
  personaIdSchema,
  updatePersonaSchema,
  type PersonaPublicDTO,
} from './dto';
import { PersonaService, type PersonaActor } from './persona.service';
import { PERSONA_SERVICE } from './tokens';

function actorOf(session: SessionRecord, request: AuthedRequest): PersonaActor {
  return {
    sessionId: session.id,
    userId: session.userId,
    tenantId: session.tenantId,
    role: session.role,
    ip: request.ip ?? null,
  };
}

@Controller('api')
@UseGuards(SessionGuard)
export class PersonaController {
  constructor(@Inject(PERSONA_SERVICE) private readonly personas: PersonaService) {}

  @Get('instances/:instanceId/personas')
  async list(
    @Param('instanceId') instanceId: string,
    @Query() query: unknown,
    @CurrentSession() session: SessionRecord,
    @Req() request: AuthedRequest,
  ): Promise<PersonaPublicDTO[]> {
    const id = parseOrThrow(instanceIdSchema, instanceId);
    const { includeArchived } = parseOrThrow(listPersonasQuerySchema, query);
    return this.personas.list(actorOf(session, request), id, {
      // 默认不含归档：归档是"重置人格"的产物，不该混在日常编辑列表里
      includeArchived: includeArchived === '1' || includeArchived === 'true',
    });
  }

  @Post('instances/:instanceId/personas')
  async create(
    @Param('instanceId') instanceId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionRecord,
    @Req() request: AuthedRequest,
  ): Promise<PersonaPublicDTO> {
    const id = parseOrThrow(instanceIdSchema, instanceId);
    const input = parseOrThrow(createPersonaSchema, body);
    return this.personas.create(actorOf(session, request), id, input);
  }

  @Get('personas/:id')
  async get(
    @Param('id') id: string,
    @CurrentSession() session: SessionRecord,
    @Req() request: AuthedRequest,
  ): Promise<PersonaPublicDTO> {
    return this.personas.get(actorOf(session, request), parseOrThrow(personaIdSchema, id));
  }

  @Patch('personas/:id')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionRecord,
    @Req() request: AuthedRequest,
  ): Promise<PersonaPublicDTO> {
    const personaId = parseOrThrow(personaIdSchema, id);
    const input = parseOrThrow(updatePersonaSchema, body);
    return this.personas.update(actorOf(session, request), personaId, input);
  }

  @Post('personas/:id/publish')
  @HttpCode(200)
  async publish(
    @Param('id') id: string,
    @CurrentSession() session: SessionRecord,
    @Req() request: AuthedRequest,
  ): Promise<PersonaPublicDTO> {
    return this.personas.publish(actorOf(session, request), parseOrThrow(personaIdSchema, id));
  }

  @Post('personas/:id/archive')
  @HttpCode(200)
  async archive(
    @Param('id') id: string,
    @CurrentSession() session: SessionRecord,
    @Req() request: AuthedRequest,
  ): Promise<PersonaPublicDTO> {
    return this.personas.archive(actorOf(session, request), parseOrThrow(personaIdSchema, id));
  }

  @Post('personas/:id/activate')
  @HttpCode(200)
  async activate(
    @Param('id') id: string,
    @CurrentSession() session: SessionRecord,
    @Req() request: AuthedRequest,
  ): Promise<PersonaPublicDTO> {
    return this.personas.activate(actorOf(session, request), parseOrThrow(personaIdSchema, id));
  }
}
