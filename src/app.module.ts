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
import { SessionModule } from './modules/session/session.module';
import { ProactiveWorker } from './workers/proactive.worker';

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
    // 定时任务（M5-3）：目前只有主动消息心跳。默认关闭的开关在实例上，
    // 没有实例打开时 worker 每 10 分钟空跑一次（只查一次"有没有开着的实例"）
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
  ],
  providers: [ProactiveWorker],
})
export class AppModule {}
