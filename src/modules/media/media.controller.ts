/**
 * 素材库接口（M4-3）。
 *
 * 只有三个动作，刻意都很窄：
 *   - 列表（含统计）：后台要能回答"它到底存了什么、占多少、有没有存上"；
 *   - 取文件：缩略图（同源 + 会话 cookie，不签名 URL）；
 *   - 删除：**软删**，名字继续占位（D034）。
 *
 * 没有"改别名"、没有"上传"、没有"批量删"：前两个会动到 D034 的语义，
 * 批量删在没有撤销的前提下太容易点错。
 */

import { Controller, Delete, Get, Inject, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { createReadStream } from 'node:fs';

import { CurrentSession, SessionGuard, type AuthedRequest } from '../auth/session.guard';
import type { SessionRecord } from '../auth/session.service';
import {
  assetIdSchema,
  assetListQuerySchema,
  instanceIdSchema,
  parseOrThrow,
  type MediaAssetListDTO,
} from './dto';
import { MediaAdminService, type MediaActor } from './media-admin.service';
import { MEDIA_ADMIN_SERVICE } from './tokens';

function actorOf(session: SessionRecord, request: AuthedRequest): MediaActor {
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
export class MediaController {
  constructor(@Inject(MEDIA_ADMIN_SERVICE) private readonly media: MediaAdminService) {}

  @Get('instances/:instanceId/assets')
  async list(
    @Param('instanceId') instanceId: string,
    @Query() query: unknown,
    @CurrentSession() session: SessionRecord,
    @Req() request: AuthedRequest,
  ): Promise<MediaAssetListDTO> {
    const id = parseOrThrow(instanceIdSchema, instanceId);
    const parsed = parseOrThrow(assetListQuerySchema, query);
    return this.media.list(actorOf(session, request), id, parsed);
  }

  @Delete('instances/:instanceId/assets/:assetId')
  async remove(
    @Param('instanceId') instanceId: string,
    @Param('assetId') assetId: string,
    @CurrentSession() session: SessionRecord,
    @Req() request: AuthedRequest,
  ): Promise<{ ok: true; alias: string; alreadyDeleted: boolean }> {
    const id = parseOrThrow(instanceIdSchema, instanceId);
    const asset = parseOrThrow(assetIdSchema, assetId);
    const result = await this.media.remove(actorOf(session, request), id, asset);
    return { ok: true, alias: result.alias, alreadyDeleted: result.alreadyDeleted };
  }

  /**
   * 取素材文件。
   *
   * 不用 `reply.sendFile()`：那是 @fastify/static 的相对根（`web/dist`），
   * 素材在 `data/media` 下，两个根混用会很容易写错。直接流式返回，顺便能精确控制缓存头。
   */
  @Get('instances/:instanceId/assets/:assetId/file')
  async file(
    @Param('instanceId') instanceId: string,
    @Param('assetId') assetId: string,
    @CurrentSession() session: SessionRecord,
    @Req() request: AuthedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const id = parseOrThrow(instanceIdSchema, instanceId);
    const asset = parseOrThrow(assetIdSchema, assetId);
    const file = await this.media.openFile(actorOf(session, request), id, asset);

    void reply
      .header('content-type', file.mime)
      // 私人素材：只允许浏览器自己缓存 5 分钟，不进任何共享缓存
      .header('cache-control', 'private, max-age=300')
      .header('x-content-type-options', 'nosniff')
      .send(createReadStream(file.filePath));
  }
}
