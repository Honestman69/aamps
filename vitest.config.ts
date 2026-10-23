import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Vitest 配置。
 * 主服务的 tsconfig 用 paths 做路径映射，测试侧要在这里同步一份，否则测试里 import 不到。
 * `@newjob/contracts` 指向源码而不是 dist：契约包不编译也能被测试直接用。
 */
export default defineConfig({
  // 把 Vite 的依赖缓存钉在项目内。
  // 默认会去系统临时目录写 ssr 缓存，在本机沙箱下会 EPERM，表现为"多文件跑只执行了一个文件"。
  cacheDir: resolve(__dirname, 'node_modules/.vite'),
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@newjob/contracts': resolve(__dirname, 'packages/contracts/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // 单文件串行更容易定位问题，也不受临时目录缓存目录影响
    fileParallelism: false,
    // Argon2 参数是 64MiB/t=3，单个用例上百毫秒，默认 5s 超时对慢机器偏紧
    testTimeout: 20000,
  },
});
