import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import { PrismaService } from './common/prisma/prisma.service';
import { AdapterModule } from './modules/adapter/adapter.module';
import { AuthModule } from './modules/auth/auth.module';
import { ConfigModule as AgentConfigModule } from './modules/config/config.module';
import { ModelModule } from './modules/model/model.module';
import { CredentialModule } from './modules/credential/credential.module';
import { InstanceModule } from './modules/instance/instance.module';
import { MediaModule } from './modules/media/media.module';
import { PersonaModule } from './modules/persona/persona.module';
import { ProactiveModule } from './modules/proactive/proactive.module';
import { RiskModule } from './modules/risk/risk.module';
import { SessionModule } from './modules/session/session.module';
import { ProactiveWorker } from './workers/proactive.worker';
import { RiskWorker } from './workers/risk.worker';

/**
 * Prisma 作为全局单例，所有模块共用一条连接。
 * 不要让各模块自己 new PrismaClient —— 热重载会攒连接。
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
class PrismaModule {}

@Module({
  imports: [
    // 只加载 .env，不往全局塞任何"主密钥"类配置（见 .env.example 顶部说明）
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    // 定时任务：主动消息心跳（M5-3，每 10 分钟）+ 风控巡检（M6-1，每 5 分钟）。
    // 两者都是"没有可做的工作就什么都不写"，不会空转打日志
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    AdapterModule,
    CredentialModule,
    AgentConfigModule,
    ModelModule,
    InstanceModule,
    MediaModule,
    PersonaModule,
    SessionModule,
    ProactiveModule,
    RiskModule,
  ],
  providers: [ProactiveWorker, RiskWorker],
})
export class AppModule {}
