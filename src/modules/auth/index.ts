/**
 * auth 模块统一出口。
 *
 * 只用到这里导出的东西；不要在业务代码里直接 `new RuntimeKeyStore()`，
 * 全进程必须共用同一个实例，否则同一个 session 在不同模块里解不解锁会不一致。
 */

export {
  AuditAction,
  AuditService,
  computeAuditHash,
  toAuditJson,
  verifyAuditChain,
  type AuditActor,
  type AuditLogRow,
  type ChainVerifyResult,
  type RecordAuditInput,
} from './audit.service';

export { unwrapStoredDek } from './dek-guard';

export {
  assertNoLegacyCiphertexts,
  scanCiphertextPrefixes,
  type CiphertextIssue,
} from './startup-check';

export {
  BootstrapService,
  type BootstrapInput,
  type BootstrapResult,
} from './bootstrap.service';

export {
  PrismaAuditLogRepository,
  PrismaCredentialAdminRepository,
  PrismaUserAuthRepository,
} from './repositories/prisma-auth.repositories';

export { PrismaTenantRepository } from './repositories/prisma-tenant.repository';

export {
  MIN_PASSWORD_LENGTH,
  PasswordService,
  type ChangePasswordInput,
  type PasswordDeps,
  type ResetPasswordInput,
  type ResetPasswordResult,
} from './password.service';

export {
  DEFAULT_UNLOCK_TTL_MS,
  RuntimeKeyStore,
  type UnlockState,
} from './runtime-key-store';

export {
  UnlockService,
  type UnlockDeps,
  type UnlockInput,
  type UnlockResult,
} from './unlock.service';

export type {
  IAuditLogRepository,
  ICredentialAdminRepository,
  ITenantRepository,
  IUserAuthRepository,
  IUserProvisionRepository,
  UserAuthRecord,
} from './ports';
