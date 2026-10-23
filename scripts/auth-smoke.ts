/**
 * 端到端冒烟：用**真实 SQLite + 真实 Prisma 仓储**跑一遍 M0 的认证链路。
 *
 * 单元测试用的是假仓储，这一步专门验证"SQL 层真的按 CAS 语义工作"：
 *   建号 → 首次解锁生成 DEK → 本人改密（Key 保留）→ 管理员重置（Key 报废）→ 审计链校验
 *
 * 用法（不要指向 dev.db，它会真的删数据）：
 *   DATABASE_URL="file:../data/smoke.db" npx tsx scripts/auth-smoke.ts
 */

import assert from 'node:assert/strict';

import { PrismaClient } from '@prisma/client';

import { decryptWithDek, encryptWithDek } from '../src/common/crypto';
import {
  AuditService,
  BootstrapService,
  PasswordService,
  PrismaAuditLogRepository,
  PrismaCredentialAdminRepository,
  PrismaTenantRepository,
  PrismaUserAuthRepository,
  RuntimeKeyStore,
  UnlockService,
} from '../src/modules/auth';

const ADMIN_PASSWORD = 'smoke-admin-pass-01';
const NEW_PASSWORD = 'smoke-admin-pass-02';
const TEMP_PASSWORD = 'smoke-temp-pass-03';
const API_KEY = 'sk-smoke-0123456789abcdef';

function step(name: string): void {
  process.stdout.write(`• ${name}\n`);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL?.includes('smoke.db')) {
    throw new Error('拒绝执行：请把 DATABASE_URL 指向 smoke.db，避免污染 dev.db');
  }

  const prisma = new PrismaClient();
  const users = new PrismaUserAuthRepository(prisma);
  const tenants = new PrismaTenantRepository(prisma);
  const credentials = new PrismaCredentialAdminRepository(prisma);
  const auditRepo = new PrismaAuditLogRepository(prisma);
  const audit = new AuditService(auditRepo);
  const keyStore = new RuntimeKeyStore();
  const unlockService = new UnlockService({ users, keyStore, audit });
  const passwordService = new PasswordService({ users, credentials, keyStore, audit });
  const bootstrap = new BootstrapService({ tenants, users, audit });

  try {
    step('创建 superadmin（首次启动种子）');
    const first = await bootstrap.ensureSuperadmin({
      username: 'smoke_admin',
      password: ADMIN_PASSWORD,
    });
    assert.equal(first.created, true, '应创建成功');
    const adminId = first.userId!;

    step('重复执行种子：不重复创建、不改密码（防后门）');
    const second = await bootstrap.ensureSuperadmin({
      username: 'smoke_admin',
      password: 'a-completely-different-password',
    });
    assert.equal(second.created, false);

    step('建号时不应有 wrappedDek（DEK 只在首次解锁时生成）');
    const beforeUnlock = await users.findAuthById(adminId);
    assert.equal(beforeUnlock?.wrappedDek, null);

    step('首次解锁：生成 DEK 并写库');
    const unlocked = await unlockService.unlock({
      sessionId: 'session-a',
      userId: adminId,
      password: ADMIN_PASSWORD,
    });
    assert.equal(unlocked.dekCreated, true);
    const dekAfterFirst = Buffer.from(keyStore.get('session-a'));

    step('加密一条示例 Key（改密后必须仍能解开）');
    const sealedKey = encryptWithDek(API_KEY, dekAfterFirst);

    step('本人改密码：重包裹，Key 保留');
    await passwordService.changePassword({
      sessionId: 'session-a',
      userId: adminId,
      oldPassword: ADMIN_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    const afterChange = await users.findAuthById(adminId);
    assert.equal(afterChange?.dekVersion, 1, 'dekVersion 不应变化');
    assert.ok(keyStore.isUnlocked('session-a'), '当前会话应保持解锁');
    assert.equal(
      decryptWithDek(sealedKey, keyStore.get('session-a')),
      API_KEY,
      '改密后原 Key 必须还能解开',
    );

    step('用新密码在另一会话解锁：拿到同一把 DEK');
    await unlockService.unlock({ sessionId: 'session-b', userId: adminId, password: NEW_PASSWORD });
    assert.ok(keyStore.get('session-b').equals(dekAfterFirst), 'DEK 必须一致');

    step('旧密码已失效');
    await assert.rejects(
      unlockService.unlock({ sessionId: 'session-c', userId: adminId, password: ADMIN_PASSWORD }),
      /用户名或密码错误/,
    );

    step('管理员重置另一个用户的密码：销毁 wrappedDek、停用凭据');
    const other = await bootstrap.ensureSuperadmin({
      username: 'smoke_admin2',
      password: ADMIN_PASSWORD,
    });
    const victimId = other.userId!;
    await unlockService.unlock({ sessionId: 'session-v', userId: victimId, password: ADMIN_PASSWORD });
    const victimDek = Buffer.from(keyStore.get('session-v'));
    const victimSealed = encryptWithDek(API_KEY, victimDek);

    const reset = await passwordService.resetPassword({
      actorUserId: adminId,
      actor: 'superadmin',
      targetUserId: victimId,
      newPassword: TEMP_PASSWORD,
      reason: 'smoke test',
    });
    assert.equal(reset.dekVersion, 2);
    assert.equal(keyStore.isUnlocked('session-v'), false, '重置后内存里的 DEK 必须消失');
    const victimAfter = await users.findAuthById(victimId);
    assert.equal(victimAfter?.wrappedDek, null);

    step('被重置用户用临时密码解锁：得到全新 DEK，解不开旧 Key');
    const reUnlocked = await unlockService.unlock({
      sessionId: 'session-v2',
      userId: victimId,
      password: TEMP_PASSWORD,
    });
    assert.equal(reUnlocked.dekCreated, true);
    assert.throws(() => decryptWithDek(victimSealed, keyStore.get('session-v2')), /解密失败/);

    step('重置自己会被拒绝（必须走改密路径）');
    await assert.rejects(
      passwordService.resetPassword({
        actorUserId: adminId,
        actor: 'superadmin',
        targetUserId: adminId,
        newPassword: TEMP_PASSWORD,
      }),
      /本人修改密码/,
    );

    step('审计哈希链完整性校验');
    const tenant = await tenants.ensureTenant('default', '自用');
    const chain = await audit.verifyTenant(tenant.id);
    assert.equal(chain.ok, true, `审计链应完整，实际：${JSON.stringify(chain)}`);

    const rows = await auditRepo.listForVerify(tenant.id, 100);
    const actions = rows.map((row) => row.action);
    for (const expected of [
      'user.create',
      'credential.unlock',
      'user.password_change',
      'user.password_reset',
    ]) {
      assert.ok(actions.includes(expected), `审计缺少 ${expected}，实际：${actions.join(',')}`);
    }
    process.stdout.write(`  审计记录 ${rows.length} 条，链完整\n`);

    // 保险：审计里绝不能出现明文 Key 或我们的密文前缀
    const dump = JSON.stringify(rows);
    assert.ok(!dump.includes(API_KEY), '审计泄漏了明文 Key');
    assert.ok(!dump.includes('dek:v1:'), '审计泄漏了密文');

    step('启动自检：库里全是当前密文格式时通过');
    const { assertNoLegacyCiphertexts, scanCiphertextPrefixes } = await import(
      '../src/modules/auth/startup-check'
    );
    await assertNoLegacyCiphertexts(prisma);

    step('启动自检：插入一条旧格式密文后必须拒绝启动');
    const legacy = await prisma.credential.create({
      data: {
        tenantId: tenant.id,
        ownerUserId: victimId,
        provider: 'deepseek',
        label: 'legacy-row',
        apiKeyEnc: 'enc:v1:AAAA:BBBB:CCCC',
        keyMasked: 'sk-****0000',
      },
      select: { id: true },
    });
    const issues = await scanCiphertextPrefixes(prisma);
    assert.ok(
      issues.some((issue) => issue.rowId === legacy.id && issue.reason.includes('enc:v1:')),
      '应识别出旧格式密文',
    );
    await assert.rejects(assertNoLegacyCiphertexts(prisma), /启动自检失败/);
    await prisma.credential.delete({ where: { id: legacy.id } });

    process.stdout.write('\nSMOKE PASSED\n');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`\nSMOKE FAILED: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
