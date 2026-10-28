/**
 * 记忆模块装配（M5-1）。
 *
 * 只有两个 provider：仓储与服务。反思用 `GatewayService` 的 `reflection` 通道
 * （走 `modelCheap`，见 `gateway.service.ts` 的 `purpose` 分支）——
 * 记忆生产者的活是"摘要"，不需要主模型。
 *
 * **不自带 controller**：这一版记忆没有对外接口。它不是给人编辑的资产，
 * 直接改库等于绕过反思闸门；要看效果，看它下一轮怎么说（以及 `MemoryItem` 表）。
 */

import { Module } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';
import { ModelModule } from '../model/model.module';
import { GATEWAY_SERVICE } from '../model/tokens';
import type { GatewayService } from '../model/gateway/gateway.service';
import { PersonaModule } from '../persona/persona.module';
import type { SelfStateService } from '../persona/self/self-state.service';
import { SELF_STATE_SERVICE } from '../persona/tokens';
import { MemoryService, type ReflectionModel, type SelfEvolution } from './memory.service';
import type { IMemoryRepository } from './ports';
import { PrismaMemoryRepository } from './repositories/prisma-memory.repository';
import { MEMORY_REPOSITORY, MEMORY_SERVICE } from './tokens';

@Module({
  imports: [ModelModule, PersonaModule],
  providers: [
    {
      provide: MEMORY_REPOSITORY,
      useFactory: (prisma: PrismaService): IMemoryRepository => new PrismaMemoryRepository(prisma),
      inject: [PrismaService],
    },
    {
      provide: MEMORY_SERVICE,
      useFactory: (
        repo: IMemoryRepository,
        gateway: GatewayService,
        self: SelfStateService,
      ): MemoryService =>
        new MemoryService(
          repo,
          gateway as unknown as ReflectionModel,
          undefined,
          self as unknown as SelfEvolution,
        ),
      inject: [MEMORY_REPOSITORY, GATEWAY_SERVICE, SELF_STATE_SERVICE],
    },
  ],
  exports: [MEMORY_SERVICE],
})
export class MemoryModule {}
