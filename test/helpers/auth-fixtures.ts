/**
 * 测试夹具：用**真实的密码学实现**造用户，不用假哈希。
 *
 * 理由：这组测试要验证的正是"密码 ↔ KEK ↔ DEK ↔ 密文"这条链路，
 * 用假哈希或假加密会把最该测的东西测掉。
 */

import { deriveKek, hashPassword, randomDek, randomSalt, unwrapDek, wrapDek } from '@/common/crypto';
import type { UserAuthRecord } from '@/modules/auth/ports';

export const TEST_PASSWORD = 'correct-horse-battery';
export const TEST_NEW_PASSWORD = 'battery-staple-v2x';
export const TEST_TENANT = 'tenant-default';

export type SeededUser = {
  record: UserAuthRecord;
  /** 包裹在 wrappedDek 里的那把 DEK（测试需要它来验证"Key 没变"） */
  dek: Buffer | null;
  password: string;
};

let seq = 0;

export async function seedUser(
  overrides: Partial<UserAuthRecord> & { password?: string; withDek?: boolean } = {},
): Promise<SeededUser> {
  seq += 1;
  const password = overrides.password ?? TEST_PASSWORD;
  const passwordHash = await hashPassword(password);
  const keySalt = randomSalt().toString('hex');

  let dek: Buffer | null = null;
  let wrappedDek: string | null = null;
  if (overrides.withDek !== false) {
    dek = randomDek();
    const kek = await deriveKek(password, Buffer.from(keySalt, 'hex'));
    wrappedDek = wrapDek(dek, kek);
    kek.fill(0);
  }

  const record: UserAuthRecord = {
    id: overrides.id ?? `user-${seq}`,
    tenantId: overrides.tenantId ?? TEST_TENANT,
    username: overrides.username ?? `tester${seq}`,
    role: overrides.role ?? 'user',
    status: overrides.status ?? 'active',
    passwordHash: overrides.passwordHash ?? passwordHash,
    keySalt: overrides.keySalt ?? keySalt,
    wrappedDek: overrides.wrappedDek !== undefined ? overrides.wrappedDek : wrappedDek,
    dekVersion: overrides.dekVersion ?? 1,
  };

  return { record, dek, password };
}

/** 用指定密码重新派生 KEK 并解开 wrappedDek，用于断言"解出来的还是同一把 DEK" */
export async function unwrapWithPassword(
  wrapped: string,
  password: string,
  keySaltHex: string,
): Promise<Buffer> {
  const kek = await deriveKek(password, Buffer.from(keySaltHex, 'hex'));
  try {
    return unwrapDek(wrapped, kek);
  } finally {
    kek.fill(0);
  }
}
