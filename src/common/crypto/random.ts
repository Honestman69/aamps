/**
 * 密码学随机数的唯一入口。
 *
 * 为什么要包一层，而不是各处直接 `crypto.randomBytes`：
 *   - 尺寸写死成常量（DEK 32B / salt 16B / IV 12B），避免"随手写个 8 字节盐"这种事故；
 *   - 禁止任何调用方自己传 `Math.random()` 或可预测种子；
 *   - 不提供"取随机整数并取模"这类危险封装（会引入模偏差）。
 *
 * 见 docs/SECURITY.md 第 2 节参数表。
 */

import { randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';

/** DEK 长度：AES-256 的密钥长度 */
export const DEK_BYTES = 32;
/** KEK 长度：Argon2id 输出长度，同样是 32B */
export const KEK_BYTES = 32;
/** keySalt 长度 */
export const SALT_BYTES = 16;
/** AES-GCM 的 IV 长度，12B 是 GCM 的标准长度 */
export const IV_BYTES = 12;
/** AES-GCM 认证标签长度 */
export const GCM_TAG_BYTES = 16;

/**
 * 取密码学安全随机字节。
 * 只允许用于密钥材料（DEK / salt / IV / token），不要拿它做业务随机数。
 */
export function randomBytes(size: number): Buffer {
  if (!Number.isInteger(size) || size <= 0) {
    throw new RangeError(`randomBytes 的尺寸必须是正整数，收到 ${String(size)}`);
  }
  return nodeRandomBytes(size);
}

/** 每用户一个的 DEK */
export function randomDek(): Buffer {
  return nodeRandomBytes(DEK_BYTES);
}

/** 每用户一个的 keySalt */
export function randomSalt(): Buffer {
  return nodeRandomBytes(SALT_BYTES);
}

/** 单次加密用的 IV，绝不复用 */
export function randomIv(): Buffer {
  return nodeRandomBytes(IV_BYTES);
}

/**
 * 尽最大努力擦除内存中的密钥材料。
 *
 * 说明：V8 可能在别处留副本（字符串化、GC 搬迁），所以这不是安全保证，
 * 只是缩短明文在堆上的驻留时间。真正的边界见 SECURITY.md 第 1 节。
 */
export function wipe(buf: Buffer | null | undefined): void {
  if (buf && Buffer.isBuffer(buf)) {
    buf.fill(0);
  }
}

/** 定长比较，防时序侧信道。长度不同直接返回 false（长度不是秘密） */
export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}
