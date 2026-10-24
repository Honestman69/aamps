/**
 * 密码学底座统一出口。
 *
 * 业务代码一律 `import { ... } from '@/common/crypto'`，
 * 不允许跨过这里直接 import `node:crypto` 做对称加解密（等于绕开格式约束与 AAD 绑定）。
 */

export {
  ARGON2_PARAMS,
  deriveKek,
  hashPassword,
  verifyPassword,
} from './argon2';

export {
  DEK_SEAL_PREFIX,
  LEGACY_SEAL_PREFIX,
  WRAP_SEAL_PREFIX,
  decryptWithDek,
  encryptWithDek,
  isDekSealed,
  isLegacySealed,
  unwrapDek,
  wrapDek,
} from './envelope';

export {
  CryptoError,
  DecryptionFailedError,
  LegacyCiphertextError,
  SealedFormatError,
} from './errors';

export {
  DEK_BYTES,
  GCM_TAG_BYTES,
  IV_BYTES,
  KEK_BYTES,
  SALT_BYTES,
  constantTimeEqual,
  randomBytes,
  randomDek,
  randomIv,
  randomSalt,
  wipe,
} from './random';

export { tokenDigest, verifyTokenDigest } from './token-digest';
