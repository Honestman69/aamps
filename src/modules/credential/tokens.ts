/**
 * 凭据模块的 DI 令牌。
 * 与 `auth/tokens.ts` 分开：两个模块的令牌混在一处，早晚有人 import 错。
 */

export const CREDENTIAL_REPOSITORY = 'CREDENTIAL_REPOSITORY';
export const CREDENTIAL_SERVICE = 'CREDENTIAL_SERVICE';
