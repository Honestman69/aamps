/**
 * 出站安全模块（M6-2 / D049）。
 *
 * 独立成一个模块是为了**避免依赖成环**：
 * `RiskModule → InstanceModule → PipelineModule`，所以 `PipelineModule` 不能反过来依赖 Risk；
 * 而节流是管道要用（`11a-throttle`）的东西。这里只依赖 Prisma，两边都能引。
 */

import { Module } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';
import { OutboundGuardService } from './outbound-guard.service';
import type { IOutboundRepository } from './ports';
import { PrismaOutboundRepository } from './repositories/prisma-outbound.repository';
import { OUTBOUND_GUARD, OUTBOUND_REPOSITORY } from './tokens';

@Module({
  providers: [
    {
      provide: OUTBOUND_REPOSITORY,
      useFactory: (prisma: PrismaService): IOutboundRepository =>
        new PrismaOutboundRepository(prisma),
      inject: [PrismaService],
    },
    {
      provide: OUTBOUND_GUARD,
      useFactory: (repo: IOutboundRepository): OutboundGuardService =>
        new OutboundGuardService({ repo }),
      inject: [OUTBOUND_REPOSITORY],
    },
  ],
  exports: [OUTBOUND_GUARD],
})
export class SafetyModule {}
