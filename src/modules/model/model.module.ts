/**
 * 模型模块（M2 只装配 Gateway；Provider 是纯函数，不需要 provider 容器）。
 *
 * `GatewayService` 必须单例：它本身无状态，但每请求 new 一个会让依赖注入白跑一遍。
 */

import { Module } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { RuntimeKeyStore } from '../auth/runtime-key-store';
import { ConfigModule } from '../config/config.module';
import { CONFIG_SERVICE } from '../config/tokens';
import type { AgentConfig } from '../config/types';
import { GatewayService } from './gateway/gateway.service';
import type { IGatewayRepository } from './gateway/ports';
import { PrismaGatewayRepository } from './gateway/repositories/prisma-gateway.repository';
import { GATEWAY_REPOSITORY, GATEWAY_SERVICE } from './tokens';

@Module({
  imports: [AuthModule, ConfigModule],
  providers: [
    {
      provide: GATEWAY_REPOSITORY,
      useFactory: (prisma: PrismaService): IGatewayRepository => new PrismaGatewayRepository(prisma),
      inject: [PrismaService],
    },
    {
      provide: GATEWAY_SERVICE,
      useFactory: (
        repo: IGatewayRepository,
        config: { get(instanceId: string, options?: { sessionId?: string | null }): Promise<{ config: AgentConfig }> },
        keyStore: RuntimeKeyStore,
      ): GatewayService => new GatewayService({ repo, config, keyStore }),
      inject: [GATEWAY_REPOSITORY, CONFIG_SERVICE, RuntimeKeyStore],
    },
  ],
  exports: [GATEWAY_SERVICE, GATEWAY_REPOSITORY],
})
export class ModelModule {}
