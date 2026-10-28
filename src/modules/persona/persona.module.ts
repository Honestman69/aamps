/**
 * 人设模块装配。
 *
 * 依赖只有两样：Prisma（全局）与 AuthModule（会话守卫 + 审计）。
 * 它**不依赖** Pipeline / Model：人设是配置面的东西，改它不该重启机器人（D007）。
 */

import { Module } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { AUDIT_SERVICE } from '../auth/tokens';
import { AuditService } from '../auth/audit.service';
import { PersonaController } from './persona.controller';
import { PersonaService } from './persona.service';
import type { IPersonaRepository } from './ports';
import { PrismaPersonaRepository } from './repositories/prisma-persona.repository';
import type { ISelfStateRepository } from './self/ports';
import { PrismaSelfStateRepository } from './self/repositories/prisma-self-state.repository';
import { SelfController } from './self/self.controller';
import { SelfStateService } from './self/self-state.service';
import {
  PERSONA_REPOSITORY,
  PERSONA_SERVICE,
  SELF_STATE_REPOSITORY,
  SELF_STATE_SERVICE,
} from './tokens';

@Module({
  imports: [AuthModule],
  controllers: [PersonaController, SelfController],
  providers: [
    {
      provide: PERSONA_REPOSITORY,
      useFactory: (prisma: PrismaService): IPersonaRepository => new PrismaPersonaRepository(prisma),
      inject: [PrismaService],
    },
    {
      provide: PERSONA_SERVICE,
      useFactory: (personas: IPersonaRepository, audit: AuditService): PersonaService =>
        new PersonaService({ personas, audit }),
      inject: [PERSONA_REPOSITORY, AUDIT_SERVICE],
    },
    {
      provide: SELF_STATE_REPOSITORY,
      useFactory: (prisma: PrismaService): ISelfStateRepository =>
        new PrismaSelfStateRepository(prisma),
      inject: [PrismaService],
    },
    {
      provide: SELF_STATE_SERVICE,
      useFactory: (repo: ISelfStateRepository, audit: AuditService): SelfStateService =>
        new SelfStateService({ repo, audit }),
      inject: [SELF_STATE_REPOSITORY, AUDIT_SERVICE],
    },
  ],
  exports: [PERSONA_SERVICE, PERSONA_REPOSITORY, SELF_STATE_SERVICE],
})
export class PersonaModule {}
