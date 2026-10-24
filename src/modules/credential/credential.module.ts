/**
 * 凭据模块装配。
 *
 * 依赖来自两处：
 *   - `PrismaService`（全局）
 *   - `AuthModule` 导出的 `RuntimeKeyStore` / `AUDIT_SERVICE` / `SessionGuard`
 *
 * `AuthModule` 必须导出 `SessionGuard`：它内部持有 `SessionService` 单例，
 * 这里若自己 `new SessionGuard(...)`，就会拿到另一个实例，验签用的不是同一份会话表。
 */

import { Module } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { AuditService } from '../auth/audit.service';
import { RuntimeKeyStore } from '../auth/runtime-key-store';
import { AUDIT_SERVICE } from '../auth/tokens';
import { CredentialController } from './credential.controller';
import { CredentialService } from './credential.service';
import type { ICredentialRepository } from './ports';
import { PrismaCredentialRepository } from './repositories/prisma-credential.repository';
import { CREDENTIAL_REPOSITORY, CREDENTIAL_SERVICE } from './tokens';

@Module({
  imports: [AuthModule],
  controllers: [CredentialController],
  providers: [
    {
      provide: CREDENTIAL_REPOSITORY,
      useFactory: (prisma: PrismaService): ICredentialRepository =>
        new PrismaCredentialRepository(prisma),
      inject: [PrismaService],
    },
    {
      provide: CREDENTIAL_SERVICE,
      useFactory: (
        credentials: ICredentialRepository,
        keyStore: RuntimeKeyStore,
        audit: AuditService,
      ): CredentialService => new CredentialService({ credentials, keyStore, audit }),
      inject: [CREDENTIAL_REPOSITORY, RuntimeKeyStore, AUDIT_SERVICE],
    },
  ],
  exports: [CREDENTIAL_SERVICE, CREDENTIAL_REPOSITORY],
})
export class CredentialModule {}
