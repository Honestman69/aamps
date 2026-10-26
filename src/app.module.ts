import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { PrismaService } from './common/prisma/prisma.service';
import { AdapterModule } from './modules/adapter/adapter.module';
import { AuthModule } from './modules/auth/auth.module';
import { ConfigModule as AgentConfigModule } from './modules/config/config.module';
import { ModelModule } from './modules/model/model.module';
import { CredentialModule } from './modules/credential/credential.module';
import { InstanceModule } from './modules/instance/instance.module';
import { PersonaModule } from './modules/persona/persona.module';

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
    PrismaModule,
    AuthModule,
    AdapterModule,
    CredentialModule,
    AgentConfigModule,
    ModelModule,
    InstanceModule,
    PersonaModule,
  ],
})
export class AppModule {}
