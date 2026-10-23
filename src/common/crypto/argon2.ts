/**
 * Argon2id KEK 派生。
 *
 * 参数写死在代码里，**不允许配置放宽**（SECURITY.md 第 2 节）：
 *   memory 64 MiB / iterations 3 / parallelism 4 / hashLen 32 / 16B salt
 *
 * 为什么用 `@node-rs/argon2` 而不是 `argon2` 包（两库都能用，这不是"前者唯一能跑"）：
 * `argon2` 走 `node-gyp-build` 找预编译包，本机 0.45.1 自带 win32-x64 预编译、装得很好；
 * 但一旦平台/ABI 不匹配它就会回落到 node-gyp 现场编译（要 VS Build Tools + Python），
 * `@node-rs/argon2` 是 napi 二进制，不存在这条回退路径。选它买的是"永远不会卡在编译上"。
 *
 * 一个容易误会的点：这里派生出的是 **KEK**，不是密码哈希。
 * 登录校验用 `passwordHash`（另一条链路），KEK 只用来解 wrappedDek，永远不落库。
 */

import { hash, hashRaw, verify } from '@node-rs/argon2';
import type { Algorithm, Version } from '@node-rs/argon2';

import { CryptoError } from './errors';
import { KEK_BYTES, SALT_BYTES } from './random';

/**
 * `Algorithm.Argon2id` = 2、`Version.V0x13` = 1。
 *
 * 这两个枚举在 `.d.ts` 里是 `declare const enum`，**运行时并不存在对应的对象**
 * （实测 `require('@node-rs/argon2').Algorithm` 是空对象），所以不能写 `Algorithm.Argon2id`：
 * esbuild/tsx 不做 const enum 内联，会拿到 undefined 然后悄悄退化成库的默认值。
 * 这里用带类型断言的数值常量，配合单元测试锁住"参数确实生效"。
 */
const ALGORITHM_ARGON2ID = 2 as Algorithm;
const VERSION_0X13 = 1 as Version;

/** 参数写死，改这里等于改安全等级，需要同步 SECURITY.md 与已有数据的迁移方案 */
export const ARGON2_PARAMS = {
  algorithm: ALGORITHM_ARGON2ID,
  version: VERSION_0X13,
  memoryCost: 65536, // 64 MiB
  timeCost: 3, // iterations
  parallelism: 4,
  outputLen: KEK_BYTES,
} as const;

/**
 * 密码 + keySalt → KEK（32B）。
 *
 * - 同一个 password + salt 必然得到同一个 KEK（否则改密码重包裹会失败）；
 * - 换 salt 就是另一把 KEK，这是 salt 的全部意义；
 * - 返回 Buffer 而不是 string：KEK 只在内存里被 `unwrapDek` / `wrapDek` 消费，
 *   转成字符串会让它莫名出现在日志和堆快照的可读区域。
 */
export async function deriveKek(password: string, salt: Buffer): Promise<Buffer> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new CryptoError('CRYPTO_PASSWORD_INVALID', '密码不能为空');
  }
  if (!Buffer.isBuffer(salt) || salt.length !== SALT_BYTES) {
    throw new CryptoError('CRYPTO_SALT_INVALID', `keySalt 必须是 ${SALT_BYTES} 字节`);
  }

  const raw = await hashRaw(password, { ...ARGON2_PARAMS, salt });
  const kek = Buffer.from(raw);
  if (kek.length !== KEK_BYTES) {
    // 正常情况下不可能发生；发生了说明库的行为变了，比继续往下跑安全
    throw new CryptoError('CRYPTO_KEK_INVALID', 'KEK 长度异常');
  }
  return kek;
}

/**
 * 生成入库用的密码哈希（PHC 字符串，自带 salt 与参数）。
 *
 * 注意**不要**拿它替代 `deriveKek`：
 *   - `passwordHash` 用于登录校验，可以落库；
 *   - KEK 用于解 wrappedDek，**永不落库**。
 * 两者用同一套 Argon2id 参数，但用途完全不同，混用等于把密钥材料写进数据库。
 */
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new CryptoError('CRYPTO_PASSWORD_INVALID', '密码不能为空');
  }
  return hash(password, ARGON2_PARAMS);
}

/**
 * 校验密码。返回 false 只代表"不匹配"，不抛异常 —— 让调用方决定转成
 * UnauthorizedError 还是别的（例如解锁失败与改密校验的文案不同）。
 * 底层抛出（PHC 串损坏等）按不匹配处理，避免把库内部错误暴露出去。
 */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  if (!passwordHash || typeof password !== 'string' || password.length === 0) {
    return false;
  }
  try {
    return await verify(passwordHash, password, ARGON2_PARAMS);
  } catch {
    return false;
  }
}
