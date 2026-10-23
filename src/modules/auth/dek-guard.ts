/**
 * 取用库里 DEK 密文时的统一错误映射。
 *
 * 为什么单独一个文件：unlock 与 changePassword 都要解 wrappedDek，
 * 两处如果各写一遍 try/catch，迟早会漂移（实际已经漏过一次：格式坏掉时
 * 漏出了 SEALED_FORMAT_INVALID，上层只能看到"密文格式不合法"，不知道该让用户重置）。
 *
 * 三种失败必须区分开，因为处理方式完全不同：
 *   - 解不开（tag 校验失败）= 数据损坏或被篡改 → 让用户走重置，**绝不能覆盖成新 DEK**
 *   - 格式不合法 = 库里的值根本不是我们的密文 → 同上，属于数据事故
 *   - 旧格式前缀 `enc:v1:` = 历史遗留 → 必须迁移，不允许双解密路径（SECURITY.md 第 8 条第 12 条）
 */

import { AppError } from '@newjob/contracts';

import {
  DecryptionFailedError,
  LegacyCiphertextError,
  SealedFormatError,
  unwrapDek,
} from '../../common/crypto';

export function unwrapStoredDek(wrapped: string, kek: Buffer): Buffer {
  try {
    return unwrapDek(wrapped, kek);
  } catch (err) {
    if (err instanceof LegacyCiphertextError) {
      throw new AppError(
        'LEGACY_CIPHERTEXT',
        '检测到旧格式密文，必须先迁移后重新录入，不允许保留两条解密路径',
        500,
      );
    }
    if (err instanceof DecryptionFailedError || err instanceof SealedFormatError) {
      throw new AppError(
        'KEYSTORE_CORRUPT',
        '密钥库数据异常，请重置密码后重新录入密钥',
        500,
      );
    }
    throw err;
  }
}
