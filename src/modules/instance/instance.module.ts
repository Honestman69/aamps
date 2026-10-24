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
import { AgentModule } from '../agent/agent.module';
import type { IAgentRepository } from '../agent/ports';
import { AGENT_REPOSITORY } from '../agent/tokens';
import { AuthModule } from '../auth/auth.module';
import { AuditService } from '../auth/audit.service';
import { RuntimeKeyStore } from '../auth/runtime-key-store';
import { AUDIT_SERVICE } from '../auth/tokens';
import { InstanceController } from './instance.controller';
import { InstanceBootstrapService } from './instance-bootstrap.service';
import { InstanceRuntime } from './instance-runtime';
import { InstanceService } from './instance.service';
import type { IInstanceRepository } from './ports';
import { PrismaInstanceRepository } from './repositories/prisma-instance.repository';
import { INSTANCE_REPOSITORY, INSTANCE_SERVICE } from './tokens';

@Module({
  imports: [AuthModule, AdapterModule, AgentModule],
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
        agents: IAgentRepository,
        keyStore: RuntimeKeyStore,
        registry: AdapterRegistry,
        runtime: InstanceRuntime,
        audit: AuditService,
      ): InstanceService =>
        new InstanceService({ instances, agents, keyStore, registry, runtime, audit }),
      inject: [
        INSTANCE_REPOSITORY,
        AGENT_REPOSITORY,
        RuntimeKeyStore,
        AdapterRegistry,
        InstanceRuntime,
        AUDIT_SERVICE,
      ],
    },
    // 启动时恢复反向实例监听（D019）：不依赖用户解锁，失败也不阻断启动
    InstanceBootstrapService,
  ],
  exports: [INSTANCE_SERVICE, InstanceRuntime],
})
export class InstanceModule {}
