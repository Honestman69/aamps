/**
 * Pipeline 模块装配。
 *
 * 依赖：Prisma（全局）、ConfigModule（读配置）、ModelModule（Gateway）、
 * 以及两个仓储（pipeline 取 owner/人设、session 读窗口 + 写消息）。
 *
 * `PipelineService` 无持久状态（兜底限频的 Map 是可丢失的），但仍注册为单例：
 * 它在每条消息链路里都要用，每请求 new 一个只会让依赖注入白跑。
 */

import { Module } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { ConfigModule } from '../config/config.module';
import { CONFIG_SERVICE } from '../config/tokens';
import type { ResolvedConfig } from '../config/types';
import { MediaAssetService } from '../media/assets/asset.service';
import { PrismaMediaAssetRepository } from '../media/assets/repositories/prisma-media-asset.repository';
import { LocalMediaFileStore } from '../media/file-store';
import { HttpImageFetcher } from '../media/fetcher';
import type { IImageFetcher } from '../media/fetcher';
import { PrismaTtsCredentialRepository } from '../media/repositories/prisma-tts-credential.repository';
import { TtsService } from '../media/tts';
import { RuntimeKeyStore } from '../auth/runtime-key-store';
import { PrismaMindStateRepository } from '../mind/state/repositories/prisma-mind-state.repository';
import type { IMindStateRepository } from '../mind/state/ports';
import { ModelModule } from '../model/model.module';
import { GATEWAY_SERVICE } from '../model/tokens';
import { GatewayService } from '../model/gateway/gateway.service';
import { PrismaSessionRepository } from '../session/repositories/prisma-session.repository';
import { PrismaSessionWindowRepository } from '../session/repositories/prisma-session-window.repository';
import type { ISessionRepository } from '../session/persistence';
import type { ISessionWindowRepository } from '../session/ports';
import { PipelineService } from './pipeline.service';
import type { IPipelineRepository } from './ports';
import { PrismaPipelineRepository } from './repositories/prisma-pipeline.repository';
import {
  IMAGE_FETCHER,
  MEDIA_ASSET_SERVICE,
  MIND_STATE_REPOSITORY,
  TTS_SERVICE,
  PIPELINE_REPOSITORY,
  PIPELINE_SERVICE,
  SESSION_REPOSITORY,
  SESSION_WINDOW_REPOSITORY,
} from './tokens';

@Module({
  imports: [AuthModule, ConfigModule, ModelModule],
  providers: [
    {
      provide: PIPELINE_REPOSITORY,
      useFactory: (prisma: PrismaService): IPipelineRepository => new PrismaPipelineRepository(prisma),
      inject: [PrismaService],
    },
    {
      provide: SESSION_REPOSITORY,
      useFactory: (prisma: PrismaService): ISessionRepository => new PrismaSessionRepository(prisma),
      inject: [PrismaService],
    },
    {
      provide: SESSION_WINDOW_REPOSITORY,
      useFactory: (prisma: PrismaService): ISessionWindowRepository =>
        new PrismaSessionWindowRepository(prisma),
      inject: [PrismaService],
    },
    {
      provide: IMAGE_FETCHER,
      useFactory: (): IImageFetcher => new HttpImageFetcher(),
    },
    {
      provide: MEDIA_ASSET_SERVICE,
      useFactory: (prisma: PrismaService): MediaAssetService =>
        new MediaAssetService({
          repo: new PrismaMediaAssetRepository(prisma),
          store: new LocalMediaFileStore(),
          images: new HttpImageFetcher(),
        }),
      inject: [PrismaService],
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
      provide: MIND_STATE_REPOSITORY,
      useFactory: (prisma: PrismaService): IMindStateRepository =>
        new PrismaMindStateRepository(prisma),
      inject: [PrismaService],
    },
    {
      provide: PIPELINE_SERVICE,
      useFactory: (
        pipeline: IPipelineRepository,
        sessions: ISessionRepository,
        windowRepo: ISessionWindowRepository,
        mind: IMindStateRepository,
        images: IImageFetcher,
        tts: TtsService,
        assets: MediaAssetService,
        config: {
          get(
            instanceId: string,
            options?: { sessionId?: string | null },
          ): Promise<Pick<ResolvedConfig, 'config' | 'sessionFlags'>>;
        },
        gateway: GatewayService,
      ): PipelineService =>
        new PipelineService({
          pipeline,
          sessions,
          windowRepo,
          mind,
          images,
          tts,
          assets,
          config,
          gateway,
        }),
      inject: [
        PIPELINE_REPOSITORY,
        SESSION_REPOSITORY,
        SESSION_WINDOW_REPOSITORY,
        MIND_STATE_REPOSITORY,
        IMAGE_FETCHER,
        TTS_SERVICE,
        MEDIA_ASSET_SERVICE,
        CONFIG_SERVICE,
        GATEWAY_SERVICE,
      ],
    },
  ],
  exports: [PIPELINE_SERVICE],
})
export class PipelineModule {}
