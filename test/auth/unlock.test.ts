/**
 * 解锁：密码 → KEK → DEK → 内存。
 *
 * 重点覆盖两个易错点：
 *   1. 首次登录 `wrappedDek` 为 null 时才生成 DEK（且并发只生成一把）；
 *   2. 密码对了但 wrappedDek 解不开 = 数据损坏，**不能**顺手覆盖成新 DEK。
 */

import { AppError, UnauthorizedError } from '@newjob/contracts';
import { describe, expect, it } from 'vitest';

import { decryptWithDek, encryptWithDek } from '@/common/crypto';
import { AuditAction, AuditService, RuntimeKeyStore, UnlockService } from '@/modules/auth';
import { FakeAuditRepository, FakeUserRepository } from '../helpers/auth-fakes';
import { TEST_PASSWORD, seedUser } from '../helpers/auth-fixtures';

async function setup(options: { withDek?: boolean; status?: string } = {}) {
  const user = await seedUser({
    username: 'alice',
    withDek: options.withDek !== false,
    status: options.status ?? 'active',
  });
  const users = new FakeUserRepository([user.record]);
  const keyStore = new RuntimeKeyStore();
  const auditRepo = new FakeAuditRepository();
  const audit = new AuditService(auditRepo);
  const service = new UnlockService({ users, keyStore, audit });
  return { user, users, keyStore, auditRepo, service };
}

describe('UnlockService.unlock', () => {
  it('首次解锁时生成 DEK 并写库，内存里立刻可用', async () => {
    const { user, users, keyStore, service, auditRepo } = await setup({ withDek: false });
    expect(user.record.wrappedDek).toBeNull();

    const result = await service.unlock({
      sessionId: 's1',
      userId: user.record.id,
      password: TEST_PASSWORD,
    });

    expect(result.dekCreated).toBe(true);
    const after = await users.findAuthById(user.record.id);
    expect(after?.wrappedDek).toMatch(/^wrap:v1:/);
    // dekVersion 不变：这不是"新一代 DEK"，只是第一次落库
    expect(after?.dekVersion).toBe(user.record.dekVersion);

    const dek = keyStore.get('s1');
    const sealed = encryptWithDek('hello', dek);
    expect(decryptWithDek(sealed, dek)).toBe('hello');

    expect(auditRepo.rows.at(-1)?.action).toBe(AuditAction.CredentialUnlock);
    expect(users.lastLoginTouched).toHaveLength(1);
  });

  it('再次解锁（另一个会话）拿到的是同一把 DEK', async () => {
    const { user, keyStore, service } = await setup();

    await service.unlock({ sessionId: 's1', userId: user.record.id, password: TEST_PASSWORD });
    await service.unlock({ sessionId: 's2', userId: user.record.id, password: TEST_PASSWORD });

    const a = keyStore.get('s1');
    const b = keyStore.get('s2');
    expect(a.equals(b)).toBe(true);
    expect(a.equals(user.dek!)).toBe(true);
  });

  it('密码错误：抛 Unauthorized，不入库不解锁不写审计', async () => {
    const { user, keyStore, service, auditRepo } = await setup();

    await expect(
      service.unlock({ sessionId: 's1', userId: user.record.id, password: 'wrong-password-x' }),
    ).rejects.toBeInstanceOf(UnauthorizedError);

    expect(keyStore.size()).toBe(0);
    expect(auditRepo.rows).toHaveLength(0);
  });

  it('账号已停用：按"用户名或密码错误"处理，不暴露停用状态', async () => {
    const { user, service } = await setup({ status: 'disabled' });

    await expect(
      service.unlock({ sessionId: 's1', userId: user.record.id, password: TEST_PASSWORD }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('wrappedDek 损坏：报密钥库异常，且绝不覆盖成新 DEK', async () => {
    const { user, users, service } = await setup();
    // 模拟数据库中密文被改了一个字符
    const corrupted = `wrap:v1:${'A'.repeat(16)}:${'B'.repeat(24)}:${'C'.repeat(40)}`;
    users.users.get(user.record.id)!.wrappedDek = corrupted;

    await expect(
      service.unlock({ sessionId: 's1', userId: user.record.id, password: TEST_PASSWORD }),
    ).rejects.toMatchObject({ code: 'KEYSTORE_CORRUPT' });

    // 关键：损坏的密文必须原样留在库里，等着走重置流程。
    // 如果这里被"顺手生成新 DEK"覆盖，用户原有 Key 就永久废了。
    expect((await users.findAuthById(user.record.id))?.wrappedDek).toBe(corrupted);
  });

  it('lock 清掉当前会话并写 credential.lock 审计', async () => {
    const { user, keyStore, service, auditRepo } = await setup();
    await service.unlock({ sessionId: 's1', userId: user.record.id, password: TEST_PASSWORD });

    const cleared = await service.lock({ sessionId: 's1', userId: user.record.id });

    expect(cleared).toBe(true);
    expect(keyStore.isUnlocked('s1')).toBe(false);
    expect(auditRepo.rows.at(-1)?.action).toBe(AuditAction.CredentialLock);
  });

  it('重复 lock 是幂等的，且不再写审计', async () => {
    const { user, service, auditRepo } = await setup();
    await service.unlock({ sessionId: 's1', userId: user.record.id, password: TEST_PASSWORD });
    await service.lock({ sessionId: 's1', userId: user.record.id });
    const countAfterFirst = auditRepo.rows.length;

    expect(await service.lock({ sessionId: 's1', userId: user.record.id })).toBe(false);
    expect(auditRepo.rows.length).toBe(countAfterFirst);
  });

  it('未知用户：抛 Unauthorized，且不写审计（不暴露账号是否存在）', async () => {
    const { service, auditRepo } = await setup();
    await expect(
      service.unlock({ sessionId: 's1', userId: 'ghost', password: TEST_PASSWORD }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(auditRepo.rows).toHaveLength(0);
  });

  it('AppError 的 code 可供上层区分"需要重置"与"需要解锁"', async () => {
    const { user, users, service } = await setup();
    users.users.get(user.record.id)!.wrappedDek = 'wrap:v1:bad';
    await expect(
      service.unlock({ sessionId: 's1', userId: user.record.id, password: TEST_PASSWORD }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
