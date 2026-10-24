/**
 * 配置模块。
 *
 * 只有两个 provider：仓储 + 服务。**服务必须是单例**——它持有缓存，
 * 每请求 new 一个等于缓存永远不命中，白白多查一次库。
 */

import { Module } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';
import { ConfigService } from './config.service';
import type { IConfigSourceRepository } from './ports';
import { PrismaConfigSourceRepository } from './repositories/prisma-config.repository';
import { CONFIG_SERVICE, CONFIG_SOURCE_REPOSITORY } from './tokens';

@Module({
  providers: [
    {
      provide: CONFIG_SOURCE_REPOSITORY,
      useFactory: (prisma: PrismaService): IConfigSourceRepository =>
        new PrismaConfigSourceRepository(prisma),
      inject: [PrismaService],
    },
    {
      provide: CONFIG_SERVICE,
      useFactory: (repo: IConfigSourceRepository): ConfigService => new ConfigService({ repo }),
      inject: [CONFIG_SOURCE_REPOSITORY],
    },
  ],
  exports: [CONFIG_SERVICE, CONFIG_SOURCE_REPOSITORY],
})
export class ConfigModule {}
