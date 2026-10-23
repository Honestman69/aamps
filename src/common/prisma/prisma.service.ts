/**
 * Prisma 连接（全局单例）。
 *
 * 用 Nest 的 lifecycle 管理连接，不要在 Controller / Service 里自己 `new PrismaClient()`，
 * 否则热重载时会攒出一堆连接。
 */

import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
