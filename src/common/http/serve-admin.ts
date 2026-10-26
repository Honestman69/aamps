/**
 * 管理后台静态托管。
 *
 * 为什么由主服务托管，而不是让用户再跑一个 nginx / `vite preview`：
 * 自用部署只有一台机器，多一层反代就多一处会忘配的地方；而且前端与接口同源之后，
 * cookie 的 `SameSite=Lax` 不需要为跨端口放宽（D005），少一个安全妥协。
 *
 * 两个必须处理的细节：
 *
 * 1. **SPA 回落**：前端用 history 路由，刷新 `/instances/x/settings` 时磁盘上没有这个文件。
 *    除了真实文件之外一律回 `index.html`，把路由交给前端。
 * 2. **`/api` 不回落**：接口 404 必须还是 JSON，否则前端 `fetch` 会拿到一坨 HTML，
 *    错误提示变成 "Unexpected token '<'" —— 那是最难查的一类问题。
 *
 * 文件不存在时**不报错，只打印一行提示**：纯后端开发（不碰前端）不该被"没构建前端"卡住。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import fastifyStatic from '@fastify/static';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/** 带 hash 的构建产物可以长期缓存；index.html 必须每次回源，否则升级后用户还在跑旧版本 */
const HASHED_ASSET = /[\\/]assets[\\/][^\\/]+\.(?:js|css|woff2?|png|jpe?g|svg|webp|gif|ico)$/;

export type AdminLogger = {
  log(message: string): void;
  warn(message: string): void;
};

/** 产物目录：默认 `web/dist`，可用 `ADMIN_DIST` 覆盖（例如打包后放在别处） */
export function resolveAdminDir(): string {
  return process.env.ADMIN_DIST?.trim() || path.resolve(process.cwd(), 'web', 'dist');
}

export async function serveAdmin(app: NestFastifyApplication, logger: AdminLogger): Promise<boolean> {
  const root = path.resolve(resolveAdminDir());
  if (!existsSync(path.join(root, 'index.html'))) {
    logger.log(`未找到管理后台产物（${root}），本次只提供接口；构建命令：pnpm web:build`);
    return false;
  }

  await app.register(fastifyStatic, {
    root,
    prefix: '/',
    // 自己注册 `/*` 路由来决定"发文件还是回落 index.html"，让插件别抢这条通配
    wildcard: false,
    index: false,
    maxAge: 0,
    setHeaders: (reply, filePath) => {
      // 插件给的是 FastifyReply，用它的 header() 而不是原生的 setHeader()
      reply.header(
        'cache-control',
        HASHED_ASSET.test(filePath) ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
      // 后台页面不参与搜索引擎与嗅探
      reply.header('x-content-type-options', 'nosniff');
      reply.header('referrer-policy', 'same-origin');
    },
  });

  const instance = app.getHttpAdapter().getInstance();

  instance.get('/*', async (request, reply) => {
    const rawPath = (request.raw.url ?? '/').split('?')[0] ?? '/';

    let pathname = rawPath;
    try {
      pathname = decodeURIComponent(rawPath);
    } catch {
      // 非法百分号编码：原样使用，下面会被"文件不存在"挡掉
    }

    // 接口路径不参与 SPA 回落
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return reply.code(404).send({ code: 'NOT_FOUND', message: '接口不存在' });
    }

    // 目录穿越：`/../../etc/passwd` 之类一律 403，而不是"文件不存在就回落"
    const candidate = path.resolve(root, `.${pathname}`);
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
      return reply.code(403).send({ code: 'FORBIDDEN', message: '非法路径' });
    }

    if (!pathname.endsWith('/') && existsSync(candidate) && path.basename(candidate).includes('.')) {
      // 必须转成 POSIX 分隔符：@fastify/static 会把 `assets\x.js` 当成非规范路径直接 403
      // （Windows 上 `path.relative` 默认给反斜杠，这个坑只在 Windows 出现）
      const relative = path.relative(root, candidate).split(path.sep).join('/');
      return reply.sendFile(relative);
    }

    return reply.sendFile('index.html');
  });

  logger.log(`管理后台已托管：${root}`);
  return true;
}
