import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app.module';
import { intEnv } from './common/config/env';
import { AppExceptionFilter } from './common/http/app-exception.filter';
import { PrismaService } from './common/prisma/prisma.service';
import { BootstrapService } from './modules/auth/bootstrap.service';
import { assertNoLegacyCiphertexts } from './modules/auth/startup-check';

/**
 * 启动顺序是有讲究的，别调换：
 *   1. 连库 → 2. 密文前缀自检（有问题直接退出，不带着双解密路径上线）
 *   → 3. 种子管理员（幂等） → 4. 才开始监听端口
 *
 * 先自检后监听：如果先监听再自检，中间那几百毫秒里接口是可用的，
 * 等于让一个有问题的实例对外服务了一小会儿。
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // 请求体上限压到 64KB：这个服务没有上传接口，没有理由接受大 body
      bodyLimit: 64 * 1024,
      // 自用部署直连，不信任 X-Forwarded-*（配了反代再显式打开）
      trustProxy: false,
    }),
  );

  app.useGlobalFilters(new AppExceptionFilter());
  app.enableShutdownHooks();

  const prisma = app.get(PrismaService);
  await assertNoLegacyCiphertexts(prisma);
  logger.log('启动自检通过：密文前缀均为 dek:v1:');

  const username = process.env.BOOTSTRAP_ADMIN_USERNAME?.trim() || 'admin';
  const seed = await app.get(BootstrapService).ensureSuperadmin({
    username,
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '',
  });
  if (seed.created) {
    logger.log(`已创建初始管理员「${username}」，请登录后立即改密码，并从环境变量里清空 BOOTSTRAP_ADMIN_PASSWORD`);
  } else {
    logger.log(`跳过初始管理员创建：${seed.reason ?? '未创建'}`);
  }

  const port = intEnv('PORT', 3000);
  const host = process.env.HOST ?? '127.0.0.1';
  await app.listen(port, host);
  logger.log(`服务已启动：http://${host}:${port}`);
}

bootstrap().catch((err: unknown) => {
  // 启动失败只打摘要，不打印可能含配置值的完整对象
  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(`[bootstrap] 启动失败：${message}`);
  process.exit(1);
});
