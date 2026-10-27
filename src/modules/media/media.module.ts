/**
 * 媒体模块装配（D033 / D034 / M4-3）。
 *
 * 这里把三样东西收在一处：**素材库**（存/取/管）、**图片抓取**（入站下载）、**语音合成**。
 * 它们本来是 Pipeline 内部私有的，M4 需要"后台也能看素材"时才被提到模块级 ——
 * 提出来之后 Pipeline 只是它的一个消费者，不再是它的宿主。
 *
 * 依赖：Prisma（全局）、AuthModule（审计 + 密钥库）。
 */

import { Module } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { AuditService } from '../auth/audit.service';
import { AUDIT_SERVICE } from '../auth/tokens';
import { RuntimeKeyStore } from '../auth/runtime-key-store';
import { MediaAssetService } from './assets/asset.service';
import { PrismaMediaAssetRepository } from './assets/repositories/prisma-media-asset.repository';
import type { IMediaAssetRepository } from './assets/ports';
import { LocalMediaFileStore } from './file-store';
import type { IMediaFileStore } from './file-store';
import { HttpImageFetcher } from './fetcher';
import type { IImageFetcher } from './fetcher';
import { MediaAdminService } from './media-admin.service';
import { MediaController } from './media.controller';
import { PrismaTtsCredentialRepository } from './repositories/prisma-tts-credential.repository';
import { TtsService } from './tts';
import {
  IMAGE_FETCHER,
  MEDIA_ADMIN_SERVICE,
  MEDIA_ASSET_REPOSITORY,
  MEDIA_ASSET_SERVICE,
  MEDIA_FILE_STORE,
  TTS_SERVICE,
} from './tokens';

@Module({
  imports: [AuthModule],
  controllers: [MediaController],
  providers: [
    {
      provide: MEDIA_FILE_STORE,
      // 目录由 MEDIA_DIR 决定；所有媒体文件（语音、素材）共用同一个根
      useFactory: (): IMediaFileStore => new LocalMediaFileStore(),
    },
    {
      provide: MEDIA_ASSET_REPOSITORY,
      useFactory: (prisma: PrismaService): IMediaAssetRepository =>
        new PrismaMediaAssetRepository(prisma),
      inject: [PrismaService],
    },
    {
      provide: IMAGE_FETCHER,
      useFactory: (): IImageFetcher => new HttpImageFetcher(),
    },
    {
      provide: MEDIA_ASSET_SERVICE,
      useFactory: (
        repo: IMediaAssetRepository,
        store: IMediaFileStore,
        images: IImageFetcher,
      ): MediaAssetService => new MediaAssetService({ repo, store, images }),
      inject: [MEDIA_ASSET_REPOSITORY, MEDIA_FILE_STORE, IMAGE_FETCHER],
    },
    {
      provide: TTS_SERVICE,
      useFactory: (prisma: PrismaService, keyStore: RuntimeKeyStore): TtsService =>
        new TtsService({
          credentials: new PrismaTtsCredentialRepository(prisma),
          keyStore,
          store: new LocalMediaFileStore(),
        }),
      inject: [PrismaService, RuntimeKeyStore],
    },
    {
      provide: MEDIA_ADMIN_SERVICE,
      useFactory: (
        repo: IMediaAssetRepository,
        store: IMediaFileStore,
        audit: AuditService,
      ): MediaAdminService => new MediaAdminService({ repo, store, audit }),
      inject: [MEDIA_ASSET_REPOSITORY, MEDIA_FILE_STORE, AUDIT_SERVICE],
    },
  ],
  exports: [
    MEDIA_ASSET_SERVICE,
    MEDIA_ADMIN_SERVICE,
    MEDIA_ASSET_REPOSITORY,
    MEDIA_FILE_STORE,
    IMAGE_FETCHER,
    TTS_SERVICE,
  ],
})
export class MediaModule {}
