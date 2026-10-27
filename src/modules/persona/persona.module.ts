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
import { PERSONA_REPOSITORY, PERSONA_SERVICE } from './tokens';

@Module({
  imports: [AuthModule],
  controllers: [PersonaController],
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
  ],
  exports: [PERSONA_SERVICE, PERSONA_REPOSITORY],
})
export class PersonaModule {}
