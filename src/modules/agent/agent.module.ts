/**
 * Agent 模块。
 *
 * 目前只提供"仓储"（能被实例模块复用），还没有 Controller ——
 * Agent 的增删改查属于 M4 管理后台；在此之前，实例创建会自动挂到用户的默认 Agent。
 */

import { Module } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';
import type { IAgentRepository } from './ports';
import { PrismaAgentRepository } from './repositories/prisma-agent.repository';
import { AGENT_REPOSITORY } from './tokens';

@Module({
  providers: [
    {
      provide: AGENT_REPOSITORY,
      useFactory: (prisma: PrismaService): IAgentRepository => new PrismaAgentRepository(prisma),
      inject: [PrismaService],
    },
  ],
  exports: [AGENT_REPOSITORY],
})
export class AgentModule {}
