/**
 * 前端构建配置。
 *
 * 两个刻意的决定：
 *
 * 1. **开发期走 Vite 代理，不开 CORS。** 后端 cookie 是 `HttpOnly + SameSite=Lax`（D005），
 *    跨端口直连要同时打开 CORS 白名单与 `SameSite=None; Secure`，等于为了开发方便削弱线上策略。
 *    代理之后浏览器看到的永远是同源 `/api/*`，后端一行都不用改。
 * 2. **构建产物 `base: '/'`**，由主服务直接托管（`src/common/http/serve-admin.ts`），
 *    不引入额外的 nginx —— 自用部署只有一台机器，多一层反代就多一处会忘配的地方。
 */

import { fileURLToPath, URL } from 'node:url';

import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

/** 后端地址：默认本机 3000；换端口只改环境变量，不改代码 */
const apiTarget = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: apiTarget,
        // 不重写 cookie 域：前后端都是 127.0.0.1，改写反而让 Set-Cookie 对不上
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Element Plus 全量引入后单块偏大；管理端首屏不是瓶颈，只把阈值调高避免噪音告警
    chunkSizeWarningLimit: 1600,
  },
});
