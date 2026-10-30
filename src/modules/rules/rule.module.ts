/**
 * 约束词模块装配（D051）。
 *
 * 依赖只有 Prisma 与审计 —— **不依赖 Pipeline**：管道反过来要用它
 * （两条拦截 pipe 通过 `PipelineDeps.rules` 拿一个窄接口）。
 */

import { Module } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { AuditService } from '../auth/audit.service';
import { AUDIT_SERVICE } from '../auth/tokens';
import type { IRuleRepository } from './ports';
import { PrismaRuleRepository } from './repositories/prisma-rule.repository';
import { RuleController } from './rule.controller';
import { RuleService } from './rule.service';
import { RULE_REPOSITORY, RULE_SERVICE } from './tokens';

@Module({
  imports: [AuthModule],
  controllers: [RuleController],
  providers: [
    {
      provide: RULE_REPOSITORY,
      useFactory: (prisma: PrismaService): IRuleRepository => new PrismaRuleRepository(prisma),
      inject: [PrismaService],
    },
    {
      provide: RULE_SERVICE,
      useFactory: (repo: IRuleRepository, audit: AuditService): RuleService =>
        new RuleService({ repo, audit }),
      inject: [RULE_REPOSITORY, AUDIT_SERVICE],
    },
  ],
  exports: [RULE_SERVICE],
})
export class RuleModule {}
