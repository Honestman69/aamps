/**
 * 凭据接口：`GET/POST /api/credentials`、`PATCH/DELETE /api/credentials/:id`。
 *
 * 权限模型很简单：**只能操作自己的**。
 * 没有"管理员查看某人的 Key 列表"这种接口 —— 不是没做，是设计上不存在
 * （superadmin 唯一与凭据相关的动作是 `reset-password` 导致的批量停用，走的是 admin 模块）。
 *
 * 归属一律取自会话：路径里只有凭据 id，没有 userId。
 * 想构造"越权访问"的请求，连个能填 userId 的地方都没有。
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
import { CredentialService, type CredentialActor } from './credential.service';
import {
  createCredentialSchema,
  credentialIdSchema,
  parseOrThrow,
  updateCredentialSchema,
  type CredentialPublicDTO,
} from './dto';
import { CREDENTIAL_SERVICE } from './tokens';

function actorOf(session: SessionRecord, request: AuthedRequest): CredentialActor {
  return {
    sessionId: session.id,
    userId: session.userId,
    tenantId: session.tenantId,
    role: session.role,
    ip: request.ip ?? null,
  };
}

@Controller('api/credentials')
@UseGuards(SessionGuard)
export class CredentialController {
  constructor(@Inject(CREDENTIAL_SERVICE) private readonly credentials: CredentialService) {}

  /** 列表：只有掩码。锁着也能看，这是刻意的（能管理元数据，看不到内容） */
  @Get()
  async list(@CurrentSession() session: SessionRecord): Promise<CredentialPublicDTO[]> {
    return this.credentials.list({ userId: session.userId });
  }

  /** 新增。未解锁会 401 `KEY_LOCKED` —— 没 DEK 就没法加密，不存在"先存着" */
  @Post()
  async create(
    @Body() body: unknown,
    @CurrentSession() session: SessionRecord,
    @Req() request: AuthedRequest,
  ): Promise<CredentialPublicDTO> {
    const input = parseOrThrow(createCredentialSchema, body);
    return this.credentials.create(actorOf(session, request), input);
  }

  /** 部分更新；传 `apiKey` 视为轮换 */
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionRecord,
    @Req() request: AuthedRequest,
  ): Promise<CredentialPublicDTO> {
    const credentialId = parseOrThrow(credentialIdSchema, id);
    const input = parseOrThrow(updateCredentialSchema, body);
    return this.credentials.update(actorOf(session, request), credentialId, input);
  }

  /** 删除。软删除的例外：凭据本身不含历史价值，留个 `enabled=false` 只会让配额算不清 */
  @Delete(':id')
  @HttpCode(200)
  async remove(
    @Param('id') id: string,
    @CurrentSession() session: SessionRecord,
    @Req() request: AuthedRequest,
  ): Promise<{ deleted: true }> {
    const credentialId = parseOrThrow(credentialIdSchema, id);
    return this.credentials.remove(actorOf(session, request), credentialId);
  }
}
