/**
 * 密码学层错误。
 *
 * 硬约束：错误对象里不允许出现密钥、密文、明文片段 —— 错误会被记日志，也可能被前端展示。
 * 所以这里所有 message 都是固定文案，绝不拼接 `sealed` 的内容。
 */

import { AppError } from '@newjob/contracts';

export class CryptoError extends AppError {
  constructor(code: string, message: string) {
    super(code, message, 400);
  }
}

/**
 * 密文解不开：密码错误，或密文被篡改。
 *
 * 这两种情况**故意不区分**：GCM 校验失败本来就无法判断是"密钥不对"还是"数据被改"，
 * 硬造一个区分除了给攻击者更多信息之外没有好处。
 */
export class DecryptionFailedError extends CryptoError {
  constructor(message = '解密失败：密钥不匹配或数据已被篡改') {
    super('DECRYPT_FAILED', message);
  }
}

/** 密文格式不合法（前缀、分段数、base64 解码后的长度） */
export class SealedFormatError extends CryptoError {
  constructor(message = '密文格式不合法') {
    super('SEALED_FORMAT_INVALID', message);
  }
}

/**
 * 遇到旧格式密文（例如历史上用全局 KEK 加的 `enc:v1:`）。
 * 触发它的唯一正确处理是"拒绝继续并提示重新录入"，不允许存在第二种解密路径。
 */
export class LegacyCiphertextError extends CryptoError {
  constructor(message = '检测到旧格式密文，必须迁移后重新录入，不允许双解密路径') {
    super('LEGACY_CIPHERTEXT', message);
  }
}
