/**
 * 信封加密：DEK ↔ apiKey，KEK ↔ DEK。
 *
 * ```
 * 密码 --Argon2id--> KEK --解开--> wrappedDek --> DEK --AES-256-GCM--> apiKeyEnc
 * ```
 *
 * 密文格式（不允许改动，改了就等于要写迁移脚本）：
 *   `dek:v1:<base64(iv)>:<base64(tag)>:<base64(cipher)>`   业务密文（API Key / 平台 Token）
 *   `wrap:v1:<base64(iv)>:<base64(tag)>:<base64(cipher)>`  被 KEK 包裹的 DEK
 *
 * 前缀不只是标记：
 *   - `dek:v1:` 让启动自检能扫出"历史上被全局 KEK 加密过的旧数据"并强制重新录入（SECURITY.md 第 8 节第 12 条）；
 *   - 同时作为 GCM 的 AAD 参与认证，所以 wrap 密文不可能被当成 dek 密文解开，反之亦然。
 *
 * 本文件是**唯一**实现对称加解密的地方。业务代码只允许通过这里的函数处理密文。
 */

import { createCipheriv, createDecipheriv } from 'node:crypto';

import { DecryptionFailedError, LegacyCiphertextError, SealedFormatError, CryptoError } from './errors';
import { DEK_BYTES, GCM_TAG_BYTES, IV_BYTES, KEK_BYTES, randomIv } from './random';

const CIPHER = 'aes-256-gcm';

/** 业务密文前缀：用 owner 的 DEK 加密 */
export const DEK_SEAL_PREFIX = 'dek:v1:';
/** DEK 包裹前缀：用用户密码派生的 KEK 加密 */
export const WRAP_SEAL_PREFIX = 'wrap:v1:';
/** 只用于识别和报警的旧格式前缀，代码里不存在用它解密的路径 */
export const LEGACY_SEAL_PREFIX = 'enc:v1:';

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function assertKey(key: Buffer, field: string): void {
  if (!Buffer.isBuffer(key)) {
    throw new CryptoError('CRYPTO_KEY_INVALID', `${field} 必须是 Buffer`);
  }
  if (key.length !== DEK_BYTES || key.length !== KEK_BYTES) {
    // DEK 与 KEK 都是 32B，这里合并判断，避免两处各写一遍
    throw new CryptoError('CRYPTO_KEY_INVALID', `${field} 长度必须是 32 字节`);
  }
}

function decodeBase64(segment: string, field: string, expectedBytes?: number): Buffer {
  if (!BASE64_RE.test(segment)) {
    throw new SealedFormatError(`密文格式不合法：${field} 不是 base64`);
  }
  const buf = Buffer.from(segment, 'base64');
  if (expectedBytes !== undefined && buf.length !== expectedBytes) {
    throw new SealedFormatError(`密文格式不合法：${field} 长度应为 ${expectedBytes} 字节`);
  }
  return buf;
}

function seal(prefix: string, key: Buffer, plaintext: Buffer, keyField: string): string {
  assertKey(key, keyField);
  const iv = randomIv();
  const cipher = createCipheriv(CIPHER, key, iv);
  // 前缀进 AAD：v1 的密文只能在 v1 的语义下解开
  cipher.setAAD(Buffer.from(prefix, 'utf8'));
  const cipherText = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${prefix}${iv.toString('base64')}:${tag.toString('base64')}:${cipherText.toString('base64')}`;
}

function open(prefix: string, key: Buffer, sealed: string, keyField: string): Buffer {
  assertKey(key, keyField);

  if (typeof sealed !== 'string' || !sealed.startsWith(prefix)) {
    // 单独把旧格式分出来，是为了让启动自检能给出"该迁移了"的明确提示
    if (typeof sealed === 'string' && sealed.startsWith(LEGACY_SEAL_PREFIX)) {
      throw new LegacyCiphertextError();
    }
    throw new SealedFormatError(`密文格式不合法：缺少 ${prefix} 前缀`);
  }

  const segments = sealed.slice(prefix.length).split(':');
  if (segments.length !== 3) {
    throw new SealedFormatError('密文格式不合法：应为 iv:tag:cipher 三段');
  }
  const [ivRaw, tagRaw, cipherRaw] = segments as [string, string, string];
  const iv = decodeBase64(ivRaw, 'iv', IV_BYTES);
  const tag = decodeBase64(tagRaw, 'tag', GCM_TAG_BYTES);
  const cipherText = decodeBase64(cipherRaw, 'cipher');

  try {
    const decipher = createDecipheriv(CIPHER, key, iv);
    decipher.setAAD(Buffer.from(prefix, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(cipherText), decipher.final()]);
  } catch {
    // 不把 sealed / 底层错误往外带：底层错误里可能包含密文片段
    throw new DecryptionFailedError();
  }
}

/**
 * 用 KEK 包裹 DEK，得到可直接入库的 `wrap:v1:...`。
 * wrappedDek 存库；KEK 只在内存活一次，用完即弃。
 */
export function wrapDek(dek: Buffer, kek: Buffer): string {
  if (!Buffer.isBuffer(dek) || dek.length !== DEK_BYTES) {
    throw new CryptoError('CRYPTO_KEY_INVALID', 'DEK 长度必须是 32 字节');
  }
  return seal(WRAP_SEAL_PREFIX, kek, dek, 'KEK');
}

/**
 * 用 KEK 解开 wrappedDek。
 * 密码错误 → 这里抛 DecryptionFailedError，上层必须转成"密码错误"或"需要解锁"，**不允许重试或降级**。
 */
export function unwrapDek(wrapped: string, kek: Buffer): Buffer {
  const dek = open(WRAP_SEAL_PREFIX, kek, wrapped, 'KEK');
  if (dek.length !== DEK_BYTES) {
    throw new SealedFormatError('解密结果不是合法的 DEK');
  }
  return dek;
}

/**
 * 用 DEK 加密业务明文（API Key、平台 accessToken / appSecret）。
 * 只允许 ModelGateway 与适配器配置装载处调用；解密侧见 `decryptWithDek` 的限制说明。
 */
export function encryptWithDek(plaintext: string, dek: Buffer): string {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new CryptoError('CRYPTO_PLAINTEXT_INVALID', '明文不能为空');
  }
  return seal(DEK_SEAL_PREFIX, dek, Buffer.from(plaintext, 'utf8'), 'DEK');
}

/**
 * 用 DEK 解出业务明文。
 *
 * 调用面必须收窄（SECURITY.md 5.3）：全局只应在 `decryptApiKey` 一处被引用，
 * 而 `decryptApiKey` 的调用方只有 `ModelGateway.dispatch()`。评审时搜引用数，多于 1 处要问为什么。
 */
export function decryptWithDek(sealed: string, dek: Buffer): string {
  return open(DEK_SEAL_PREFIX, dek, sealed, 'DEK').toString('utf8');
}

/** 是否为当前版本的业务密文（启动自检用） */
export function isDekSealed(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(DEK_SEAL_PREFIX);
}

/** 是否为旧格式密文（启动自检用，命中即拒绝启动） */
export function isLegacySealed(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(LEGACY_SEAL_PREFIX);
}
