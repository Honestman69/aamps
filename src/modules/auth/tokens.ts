/**
 * DI 令牌。
 *
 * 统一放一处的原因：字符串令牌写错一个字母不会报错，只会在运行时抛
 * "Nest can't resolve dependencies" —— 那是最浪费时间的一类错误。
 */

export const USER_AUTH_REPOSITORY = 'USER_AUTH_REPOSITORY';
export const USER_PROVISION_REPOSITORY = 'USER_PROVISION_REPOSITORY';
export const ADMIN_USER_REPOSITORY = 'ADMIN_USER_REPOSITORY';
export const TENANT_REPOSITORY = 'TENANT_REPOSITORY';
export const CREDENTIAL_ADMIN_REPOSITORY = 'CREDENTIAL_ADMIN_REPOSITORY';
export const AUDIT_LOG_REPOSITORY = 'AUDIT_LOG_REPOSITORY';
export const AUDIT_SERVICE = 'AUDIT_SERVICE';
