/**
 * 会话模块（M4-6）：**只有管理端只读接口**。
 *
 * 消息主链路的读写（`ensureSession` / `saveInbound` / `saveOutbound` / `loadSlice`）仍然由
 * `PipelineModule` 自己装配 —— 它们是"处理一条消息"的一部分，不该因为后台要看记录
 * 就被拉成一个跨模块依赖（D040 之后管道已经够清楚了，不要再给它加一条向外的边）。
 *
 * 这里的仓储只服务于"看"，所以单独一个 `PrismaSessionAdminRepository`：
 * 写入路径的仓储不需要也不该长出 `listForUser` 这种查询方法。
 */

import { Module } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';
import type { ISessionAdminRepository } from './ports';
import { PrismaSessionAdminRepository } from './repositories/prisma-session-admin.repository';
import { SessionAdminService } from './session-admin.service';
import { SessionController } from './session.controller';
import { SESSION_ADMIN_REPOSITORY } from './tokens';

@Module({
  imports: [AuthModule],
  controllers: [SessionController],
  providers: [
    {
      provide: SESSION_ADMIN_REPOSITORY,
      useFactory: (prisma: PrismaService): ISessionAdminRepository =>
        new PrismaSessionAdminRepository(prisma),
      inject: [PrismaService],
    },
    {
      // 用**类**作为令牌：这个服务没有第二实现，"接口 + 字符串令牌"只会让注入点
      // 多写一个 @Inject(字符串)，而写错字符串的报错要等到启动才出现
      provide: SessionAdminService,
      useFactory: (sessions: ISessionAdminRepository): SessionAdminService =>
        new SessionAdminService({ sessions }),
      inject: [SESSION_ADMIN_REPOSITORY],
    },
  ],
  exports: [SessionAdminService],
})
export class SessionModule {}
