/**
 * Auth 模块装配。
 *
 * 关键点：**`RuntimeKeyStore` 与 `SessionService` 必须是单例**。
 * 每请求 new 一个的话，解锁写进 A 实例、取的时候查 B 实例，
 * 表现就是"刚登录就说未解锁"，而且极难排查。
 *
 * 全部用 `useFactory` + 显式 `inject`，不依赖 `emitDecoratorMetadata`。
 * 好处：以后想在 vitest（esbuild，不产出装饰器元数据）里直接建模块也能跑。
 */

import { Module } from '@nestjs/common';

import { requireSessionSecret } from '../../common/config/env';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AdminController, AUDIT_SERVICE } from './admin.controller';
import { AuditService } from './audit.service';
import { AuthController } from './auth.controller';
import { BootstrapService } from './bootstrap.service';
import { PasswordService } from './password.service';
import type {
  IAuditLogRepository,
  ICredentialAdminRepository,
  ITenantRepository,
  IUserAuthRepository,
  IUserProvisionRepository,
} from './ports';
import {
  PrismaAuditLogRepository,
  PrismaCredentialAdminRepository,
  PrismaUserAdminQueryRepository,
  PrismaUserAuthRepository,
} from './repositories/prisma-auth.repositories';
import { PrismaTenantRepository } from './repositories/prisma-tenant.repository';
import { RuntimeKeyStore } from './runtime-key-store';
import { SessionGuard } from './session.guard';
import { SessionService } from './session.service';
import {
  ADMIN_USER_REPOSITORY,
  AUDIT_LOG_REPOSITORY,
  CREDENTIAL_ADMIN_REPOSITORY,
  TENANT_REPOSITORY,
  USER_AUTH_REPOSITORY,
  USER_PROVISION_REPOSITORY,
} from './tokens';
import { UnlockService } from './unlock.service';

@Module({
  controllers: [AuthController, AdminController],
  providers: [
    // ── 进程级单例：DEK 与会话靠它们串起来 ──
    { provide: RuntimeKeyStore, useFactory: (): RuntimeKeyStore => new RuntimeKeyStore() },
    {
      provide: SessionService,
      useFactory: (): SessionService => new SessionService(requireSessionSecret()),
    },

    // ── 仓储 ──
    {
      provide: USER_AUTH_REPOSITORY,
      useFactory: (prisma: PrismaService): IUserAuthRepository => new PrismaUserAuthRepository(prisma),
      inject: [PrismaService],
    },
    {
      provide: USER_PROVISION_REPOSITORY,
      useFactory: (prisma: PrismaService): IUserProvisionRepository =>
        new PrismaUserAuthRepository(prisma),
      inject: [PrismaService],
    },
    {
      provide: ADMIN_USER_REPOSITORY,
      useFactory: (prisma: PrismaService) => new PrismaUserAdminQueryRepository(prisma),
      inject: [PrismaService],
    },
    {
      provide: TENANT_REPOSITORY,
      useFactory: (prisma: PrismaService): ITenantRepository => new PrismaTenantRepository(prisma),
      inject: [PrismaService],
    },
    {
      provide: CREDENTIAL_ADMIN_REPOSITORY,
      useFactory: (prisma: PrismaService): ICredentialAdminRepository =>
        new PrismaCredentialAdminRepository(prisma),
      inject: [PrismaService],
    },
    {
      provide: AUDIT_LOG_REPOSITORY,
      useFactory: (prisma: PrismaService): IAuditLogRepository => new PrismaAuditLogRepository(prisma),
      inject: [PrismaService],
    },

    // ── 领域服务 ──
    {
      provide: AUDIT_SERVICE,
      useFactory: (repo: IAuditLogRepository): AuditService => new AuditService(repo),
      inject: [AUDIT_LOG_REPOSITORY],
    },
    {
      provide: UnlockService,
      useFactory: (
        users: IUserAuthRepository,
        keyStore: RuntimeKeyStore,
        audit: AuditService,
      ): UnlockService => new UnlockService({ users, keyStore, audit }),
      inject: [USER_AUTH_REPOSITORY, RuntimeKeyStore, AUDIT_SERVICE],
    },
    {
      provide: PasswordService,
      useFactory: (
        users: IUserAuthRepository,
        credentials: ICredentialAdminRepository,
        keyStore: RuntimeKeyStore,
        audit: AuditService,
      ): PasswordService => new PasswordService({ users, credentials, keyStore, audit }),
      inject: [USER_AUTH_REPOSITORY, CREDENTIAL_ADMIN_REPOSITORY, RuntimeKeyStore, AUDIT_SERVICE],
    },
    {
      provide: BootstrapService,
      useFactory: (
        tenants: ITenantRepository,
        users: IUserProvisionRepository,
        audit: AuditService,
      ): BootstrapService => new BootstrapService({ tenants, users, audit }),
      inject: [TENANT_REPOSITORY, USER_PROVISION_REPOSITORY, AUDIT_SERVICE],
    },
    {
      provide: SessionGuard,
      useFactory: (sessions: SessionService): SessionGuard => new SessionGuard(sessions),
      inject: [SessionService],
    },
  ],
  exports: [
    RuntimeKeyStore,
    SessionService,
    AUDIT_SERVICE,
    BootstrapService,
    UnlockService,
    PasswordService,
    USER_AUTH_REPOSITORY,
    USER_PROVISION_REPOSITORY,
    TENANT_REPOSITORY,
  ],
})
export class AuthModule {}
