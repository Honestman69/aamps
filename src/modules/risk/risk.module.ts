/**
 * 风控模块装配（M6-1 / D048）。
 *
 * 依赖两样：Prisma（读信号、写结论）与 `InstanceService`（停实例时断开连接）。
 * **不依赖 Pipeline**：健康分不参与对话判断；静默是通过 `silentUntil` 这一列
 * 被治理 pipe 读到的（管道只读库，不认识风险模块）。
 */

import { Module } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { InstanceModule } from '../instance/instance.module';
import { INSTANCE_SERVICE } from '../instance/tokens';
import type { IRiskRepository } from './ports';
import { PrismaRiskRepository } from './repositories/prisma-risk.repository';
import { RiskController } from './risk.controller';
import { RiskService, type SweepReport } from './risk.service';
import { RISK_REPOSITORY, RISK_SERVICE } from './tokens';

/** 停实例时只需要"断开连接"这一个能力 */
type ConnectionDropper = {
  dropConnection(instanceId: string, reason: string): Promise<boolean>;
};

@Module({
  imports: [AuthModule, InstanceModule],
  controllers: [RiskController],
  providers: [
    {
      provide: RISK_REPOSITORY,
      useFactory: (prisma: PrismaService): IRiskRepository => new PrismaRiskRepository(prisma),
      inject: [PrismaService],
    },
    {
      provide: RISK_SERVICE,
      useFactory: (repo: IRiskRepository, instance: ConnectionDropper): RiskService =>
        new RiskService({
          repo,
          connection: {
            drop: (instanceId: string, reason: string) => instance.dropConnection(instanceId, reason),
          },
        }),
      inject: [RISK_REPOSITORY, INSTANCE_SERVICE],
    },
  ],
  exports: [RISK_SERVICE],
})
export class RiskModule {}

export type { SweepReport };
