/**
 * 主动消息模块装配（M5-3 / D047）。
 *
 * 依赖偏多，但每一个都是"必须"的：
 *   - 配置：读实例开关（关着就一条候选都不查）
 *   - owner/人设：没有"它自己"就不该开口
 *   - 心智/记忆/演化：一句话的口气取决于它此刻累不累、记得什么、变成了什么样
 *   - 网关：生成那一句话
 *   - 会话仓储：落库（先发后落库）
 *   - 实例服务：**唯一**知道当前连接挂在哪个 adapter 上的地方
 */

import { Module } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { ConfigModule } from '../config/config.module';
import { CONFIG_SERVICE } from '../config/tokens';
import { InstanceModule } from '../instance/instance.module';
import { INSTANCE_SERVICE } from '../instance/tokens';
import { MemoryModule } from '../memory/memory.module';
import { MEMORY_SERVICE } from '../memory/tokens';
import { ModelModule } from '../model/model.module';
import { GATEWAY_SERVICE } from '../model/tokens';
import { PersonaModule } from '../persona/persona.module';
import { SELF_STATE_SERVICE } from '../persona/tokens';
import { PipelineModule } from '../pipeline/pipeline.module';
import {
  MIND_STATE_REPOSITORY,
  PIPELINE_REPOSITORY,
  SESSION_REPOSITORY,
} from '../pipeline/tokens';
import type { OutboundAction } from '@newjob/contracts';

import type { IProactiveRepository } from './ports';
import { ProactiveService, type ProactiveDeps } from './proactive.service';
import { PrismaProactiveRepository } from './repositories/prisma-proactive.repository';
import { PROACTIVE_REPOSITORY, PROACTIVE_SERVICE } from './tokens';

/** 每个依赖只声明用得到的形状（都来自 `ProactiveDeps`，避免两处各写一份） */
type ConfigReader = ProactiveDeps['config'];
type PipelineReader = ProactiveDeps['pipeline'];
type MemoryReader = ProactiveDeps['memory'];
type SelfReader = ProactiveDeps['self'];
type MindReader = ProactiveDeps['mind'];
type GatewayReader = ProactiveDeps['gateway'];
type SessionWriter = ProactiveDeps['sessions'];
/** 实例服务多出来的那一个方法：主动消息唯一的出站口 */
type InstanceSender = { sendOutbound(instanceId: string, action: OutboundAction): Promise<{ ok: boolean }> };

@Module({
  imports: [
    AuthModule,
    ConfigModule,
    InstanceModule,
    MemoryModule,
    ModelModule,
    PersonaModule,
    // 三个仓储（owner/人设、会话、心智）由管道模块提供并导出
    PipelineModule,
  ],
  providers: [
    {
      provide: PROACTIVE_REPOSITORY,
      useFactory: (prisma: PrismaService): IProactiveRepository =>
        new PrismaProactiveRepository(prisma),
      inject: [PrismaService],
    },
    {
      provide: PROACTIVE_SERVICE,
      useFactory: (
        repo: IProactiveRepository,
        config: ConfigReader,
        pipeline: PipelineReader,
        mind: MindReader,
        memory: MemoryReader,
        self: SelfReader,
        gateway: GatewayReader,
        sessions: SessionWriter,
        instance: InstanceSender,
      ): ProactiveService =>
        new ProactiveService({
          repo,
          config,
          pipeline,
          mind,
          memory,
          self,
          gateway,
          sessions,
          sender: {
            send: (instanceId, action) => instance.sendOutbound(instanceId, action),
          },
        }),
      inject: [
        PROACTIVE_REPOSITORY,
        CONFIG_SERVICE,
        PIPELINE_REPOSITORY,
        MIND_STATE_REPOSITORY,
        MEMORY_SERVICE,
        SELF_STATE_SERVICE,
        GATEWAY_SERVICE,
        SESSION_REPOSITORY,
        INSTANCE_SERVICE,
      ],
    },
  ],
  exports: [PROACTIVE_SERVICE],
})
export class ProactiveModule {}
