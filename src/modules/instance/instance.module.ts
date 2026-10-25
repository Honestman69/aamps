/**
 * 实例模块装配。
 *
 * 依赖链：PrismaService（全局）→ AdapterRegistry（AdapterModule）
 *        + RuntimeKeyStore / AuditService / SessionGuard（AuthModule）
 *
 * `InstanceRuntime` 必须是单例：它存的是"哪条记录当前真的连着"，
 * 每请求 new 一个的话，connect 写进 A、disconnect 查 B，表现为"断不掉"。
 */

import { Module } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';
import { AdapterModule } from '../adapter/adapter.module';
import { AdapterRegistry } from '../adapter/adapter-registry';
import { AuthModule } from '../auth/auth.module';
import { AuditService } from '../auth/audit.service';
import { ConfigModule } from '../config/config.module';
import { CredentialModule } from '../credential/credential.module';
import { CREDENTIAL_REPOSITORY } from '../credential/tokens';
import { CONFIG_SERVICE } from '../config/tokens';
import { RuntimeKeyStore } from '../auth/runtime-key-store';
import { AUDIT_SERVICE } from '../auth/tokens';
import { PipelineModule } from '../pipeline/pipeline.module';
import { PIPELINE_SERVICE } from '../pipeline/tokens';
import { InstanceController } from './instance.controller';
import { InstanceBootstrapService } from './instance-bootstrap.service';
import { InstanceRuntime } from './instance-runtime';
import { InstanceService } from './instance.service';
import type { IInstanceRepository } from './ports';
import { PrismaInstanceRepository } from './repositories/prisma-instance.repository';
import { INSTANCE_REPOSITORY, INSTANCE_SERVICE } from './tokens';

@Module({
  imports: [AuthModule, AdapterModule, ConfigModule, CredentialModule, PipelineModule],
  controllers: [InstanceController],
  providers: [
    { provide: InstanceRuntime, useFactory: (): InstanceRuntime => new InstanceRuntime() },
    {
      provide: INSTANCE_REPOSITORY,
      useFactory: (prisma: PrismaService): IInstanceRepository =>
        new PrismaInstanceRepository(prisma),
      inject: [PrismaService],
    },
    {
      provide: INSTANCE_SERVICE,
      useFactory: (
        instances: IInstanceRepository,
        keyStore: RuntimeKeyStore,
        registry: AdapterRegistry,
        runtime: InstanceRuntime,
        audit: AuditService,
        configCache: { invalidate(instanceId: string): number },
        credentials: { findForUser(userId: string, id: string): Promise<unknown | null> },
        pipeline: { handle(message: unknown, send: unknown, options: unknown): Promise<void> },
      ): InstanceService =>
        new InstanceService({ instances, keyStore, registry, runtime, audit, configCache, credentials, pipeline }),
      inject: [
        INSTANCE_REPOSITORY,
        RuntimeKeyStore,
        AdapterRegistry,
        InstanceRuntime,
        AUDIT_SERVICE,
        CONFIG_SERVICE,
        CREDENTIAL_REPOSITORY,
        PIPELINE_SERVICE,
      ],
    },
    // 启动时恢复反向实例监听（D019）：不依赖用户解锁，失败也不阻断启动
    InstanceBootstrapService,
  ],
  exports: [INSTANCE_SERVICE, InstanceRuntime],
})
export class InstanceModule {}
