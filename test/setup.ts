/**
 * 测试环境的最小 env。
 *
 * 有些模块（会话签名、token 摘要）在**调用时**才读 env，而不是在 import 时。
 * 测试里没有 `.env`，所以要在这里补一个明确的值——注意是"补"，
 * 不覆盖 CI 或本地已经设好的值。
 */

if (!process.env.SESSION_SECRET) {
  // 长度必须 >= 32，否则 requireSessionSecret 会抛错
  process.env.SESSION_SECRET = 'test-only-session-secret-0123456789abcdef';
}

if (!process.env.DATABASE_URL) {
  // Prisma 客户端在构造时就要求有这个变量，测试里大多不真的连库
  process.env.DATABASE_URL = 'file:../data/dev.db';
}
