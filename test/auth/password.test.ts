/**
 * 改密 / 重置：两条语义相反的路径（D004）。
 *
 * 最关键的一条断言：**本人改密码后，原有 API Key 必须仍能解密**。
 * 这条一旦挂了，说明 DEK 被换掉了，用户所有 Key 会静默失效。
 */

import { BadRequestError, ForbiddenError, UnauthorizedError } from '@newjob/contracts';
import { describe, expect, it } from 'vitest';

import { decryptWithDek, encryptWithDek, verifyPassword } from '@/common/crypto';
import {
  AuditAction,
  AuditService,
  PasswordService,
  RuntimeKeyStore,
  UnlockService,
  type PasswordDeps,
} from '@/modules/auth';
import { FakeAuditRepository, FakeCredentialRepository, FakeUserRepository } from '../helpers/auth-fakes';
import {
  TEST_NEW_PASSWORD,
  TEST_PASSWORD,
  seedUser,
  unwrapWithPassword,
} from '../helpers/auth-fixtures';

const API_KEY = 'sk-live-0123456789abcdef';

async function setup(options: { withDek?: boolean; disableRepoWrites?: boolean } = {}) {
  const user = await seedUser({ username: 'alice', withDek: options.withDek !== false });
  const users = new FakeUserRepository([user.record]);
  if (options.disableRepoWrites) {
    // 模拟并发：读取之后、写入之前被其他会话改过 → CAS 必然失败
    users.updateSecretsAtomically = async () => false;
  }
  const credentials = new FakeCredentialRepository(3);
  const keyStore = new RuntimeKeyStore();
  const auditRepo = new FakeAuditRepository();
  const audit = new AuditService(auditRepo);
  const deps: PasswordDeps = { users, credentials, keyStore, audit };
  const service = new PasswordService(deps);
  return { user, users, credentials, keyStore, auditRepo, service };
}

describe('changePassword：本人改密，Key 必须原样保留', () => {
  it('重包裹后同一把 DEK 仍能解出改密前加密的 Key', async () => {
    const { user, users, keyStore, service, auditRepo } = await setup();
    const dek = user.dek!;
    const sealedBefore = encryptWithDek(API_KEY, dek);

    keyStore.set('s1', user.record.id, dek);
    const before = await users.findAuthById(user.record.id);

    await service.changePassword({
      sessionId: 's1',
      userId: user.record.id,
      oldPassword: TEST_PASSWORD,
      newPassword: TEST_NEW_PASSWORD,
    });

    const after = await users.findAuthById(user.record.id);
    // 1. 库里的包裹密文换了，密码哈希换了
    expect(after?.wrappedDek).not.toBe(before?.wrappedDek);
    expect(after?.passwordHash).not.toBe(before?.passwordHash);
    // 2. dekVersion 不变（DEK 本身没换，只是换了包裹它的 KEK）
    expect(after?.dekVersion).toBe(before?.dekVersion);

    // 3. 用新密码解出的 DEK 与旧 DEK 完全相同
    const dekAfter = await unwrapWithPassword(after!.wrappedDek!, TEST_NEW_PASSWORD, after!.keySalt);
    expect(dekAfter.equals(dek)).toBe(true);

    // 4. 改密前加密的 Key，用当前会话里的 DEK 仍能解开（这就是"Key 不受影响"）
    const storeDek = keyStore.get('s1');
    expect(decryptWithDek(sealedBefore, storeDek)).toBe(API_KEY);

    // 5. 密码真的换了
    expect(await verifyPassword(after!.passwordHash, TEST_PASSWORD)).toBe(false);
    expect(await verifyPassword(after!.passwordHash, TEST_NEW_PASSWORD)).toBe(true);

    // 6. 审计写了 password_change，且不含任何密钥材料
    const row = auditRepo.rows.at(-1);
    expect(row?.action).toBe(AuditAction.UserPasswordChange);
    expect(row?.afterJson).toContain('"keysUnaffected":true');
    expect(row?.afterJson).not.toContain('dek:v1:');
  });

  it('改密后其他会话被清掉，当前会话保持解锁', async () => {
    const { user, keyStore, service } = await setup();
    keyStore.set('s1', user.record.id, user.dek!);
    keyStore.set('s2', user.record.id, user.dek!);

    await service.changePassword({
      sessionId: 's1',
      userId: user.record.id,
      oldPassword: TEST_PASSWORD,
      newPassword: TEST_NEW_PASSWORD,
    });

    expect(keyStore.isUnlocked('s1')).toBe(true);
    expect(keyStore.isUnlocked('s2')).toBe(false);
  });

  it('旧密码错误时什么都不改，也不写审计', async () => {
    const { user, users, service, auditRepo } = await setup();
    const before = await users.findAuthById(user.record.id);

    await expect(
      service.changePassword({
        sessionId: 's1',
        userId: user.record.id,
        oldPassword: 'wrong-password-123',
        newPassword: TEST_NEW_PASSWORD,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedError);

    const after = await users.findAuthById(user.record.id);
    expect(after).toEqual(before);
    expect(auditRepo.rows).toHaveLength(0);
  });

  it('新密码不满足策略（太短）直接拒绝', async () => {
    const { user, service } = await setup();
    await expect(
      service.changePassword({
        sessionId: 's1',
        userId: user.record.id,
        oldPassword: TEST_PASSWORD,
        newPassword: 'short',
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('新旧密码相同直接拒绝（否则等于白改）', async () => {
    const { user, service } = await setup();
    await expect(
      service.changePassword({
        sessionId: 's1',
        userId: user.record.id,
        oldPassword: TEST_PASSWORD,
        newPassword: TEST_PASSWORD,
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('并发改密（CAS 失败）时拒绝覆盖，而不是悄悄写坏数据', async () => {
    const { user, service } = await setup({ disableRepoWrites: true });
    await expect(
      service.changePassword({
        sessionId: 's1',
        userId: user.record.id,
        oldPassword: TEST_PASSWORD,
        newPassword: TEST_NEW_PASSWORD,
      }),
    ).rejects.toThrow(/其他会话/);
  });

  it('重置后尚未解锁（wrappedDek 为 null）时不能改密', async () => {
    const { user, service } = await setup({ withDek: false });
    await expect(
      service.changePassword({
        sessionId: 's1',
        userId: user.record.id,
        oldPassword: TEST_PASSWORD,
        newPassword: TEST_NEW_PASSWORD,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('resetPassword：管理员重置，Key 必须报废', () => {
  it('销毁 wrappedDek、dekVersion+1、停用全部凭据、清空会话', async () => {
    const { user, users, credentials, keyStore, service, auditRepo } = await setup();
    keyStore.set('s1', user.record.id, user.dek!);

    const result = await service.resetPassword({
      actorUserId: 'admin-1',
      actor: 'superadmin',
      targetUserId: user.record.id,
      newPassword: TEST_NEW_PASSWORD,
      reason: '忘记密码',
    });

    const after = await users.findAuthById(user.record.id);
    expect(after?.wrappedDek).toBeNull();
    expect(after?.dekVersion).toBe(user.record.dekVersion + 1);
    expect(result.dekVersion).toBe(user.record.dekVersion + 1);
    // 管理员设的临时密码生效
    expect(await verifyPassword(after!.passwordHash, TEST_NEW_PASSWORD)).toBe(true);
    // 凭据全部停用，且原因写清楚
    expect(credentials.disabledBatches).toEqual([
      { userId: user.record.id, reason: '密码已重置，密钥需重新录入' },
    ]);
    expect(result.disabledCredentials).toBe(3);
    // 内存里的 DEK 必须立刻消失
    expect(keyStore.isUnlocked('s1')).toBe(false);

    const row = auditRepo.rows.at(-1);
    expect(row?.action).toBe(AuditAction.UserPasswordReset);
    expect(row?.actor).toBe('superadmin');
    expect(row?.targetOwnerId).toBe(user.record.id);
    expect(row?.afterJson).toContain('"wrapDekDestroyed":true');
  });

  it('操作者就是目标用户时拒绝 —— 本人改密必须走 changePassword', async () => {
    const { user, users, service } = await setup();
    const before = await users.findAuthById(user.record.id);

    await expect(
      service.resetPassword({
        actorUserId: user.record.id,
        actor: 'superadmin',
        targetUserId: user.record.id,
        newPassword: TEST_NEW_PASSWORD,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(await users.findAuthById(user.record.id)).toEqual(before);
  });

  it('目标用户不存在时抛 Forbidden（不区分"不存在"和"无权"，防枚举）', async () => {
    const { service } = await setup();
    await expect(
      service.resetPassword({
        actorUserId: 'admin-1',
        actor: 'superadmin',
        targetUserId: 'no-such-user',
        newPassword: TEST_NEW_PASSWORD,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('resetPasswordSelf：忘记密码，复用销毁语义', () => {
  it('按用户名重置会销毁 wrappedDek 并记 password_reset_self', async () => {
    const { user, users, credentials, auditRepo, service } = await setup();

    const result = await service.resetPasswordSelf({
      username: user.record.username,
      newPassword: TEST_NEW_PASSWORD,
    });

    expect(result.matched).toBe(true);
    const after = await users.findAuthById(user.record.id);
    expect(after?.wrappedDek).toBeNull();
    expect(credentials.disabledBatches).toHaveLength(1);
    expect(auditRepo.rows.at(-1)?.action).toBe(AuditAction.UserPasswordResetSelf);
    expect(await verifyPassword(after!.passwordHash, TEST_NEW_PASSWORD)).toBe(true);
  });

  it('用户名不存在时不抛错、不写审计（否则会被当成账号探测器）', async () => {
    const { auditRepo, service } = await setup();
    const result = await service.resetPasswordSelf({
      username: 'ghost',
      newPassword: TEST_NEW_PASSWORD,
    });

    expect(result.matched).toBe(false);
    expect(auditRepo.rows).toHaveLength(0);
  });

  it('重置后重新解锁拿到的是全新 DEK，解不开旧 Key（"报废"是真的）', async () => {
    const { user, users, keyStore, auditRepo, service } = await setup();
    const oldDek = user.dek!;
    const sealedOld = encryptWithDek(API_KEY, oldDek);

    await service.resetPasswordSelf({
      username: user.record.username,
      newPassword: TEST_NEW_PASSWORD,
    });

    const unlock = new UnlockService({
      users,
      keyStore,
      audit: new AuditService(auditRepo),
    });
    const result = await unlock.unlock({
      sessionId: 's-new',
      userId: user.record.id,
      password: TEST_NEW_PASSWORD,
    });

    expect(result.dekCreated).toBe(true);
    const freshDek = keyStore.get('s-new');
    expect(freshDek.equals(oldDek)).toBe(false);
    expect(() => decryptWithDek(sealedOld, freshDek)).toThrow();
  });
});
