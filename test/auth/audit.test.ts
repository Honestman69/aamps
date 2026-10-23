/**
 * 审计哈希链：只增不改，任何中间记录的删改都必须能被发现。
 */

import { describe, expect, it } from 'vitest';

import {
  AuditAction,
  AuditService,
  computeAuditHash,
  toAuditJson,
  verifyAuditChain,
} from '@/modules/auth';
import { FakeAuditRepository } from '../helpers/auth-fakes';
import { TEST_TENANT } from '../helpers/auth-fixtures';

function makeService() {
  const repo = new FakeAuditRepository();
  const clock = { t: new Date('2026-10-23T10:00:00Z') };
  const service = new AuditService(repo, () => clock.t);
  const tick = () => {
    clock.t = new Date(clock.t.getTime() + 1000);
  };
  return { repo, service, tick };
}

describe('审计哈希链', () => {
  it('连续追加三条后链完整，prevHash 逐条衔接', async () => {
    const { repo, service, tick } = makeService();

    await service.record({
      tenantId: TEST_TENANT,
      actor: 'user',
      actorUserId: 'u1',
      action: AuditAction.CredentialUnlock,
    });
    tick();
    await service.record({
      tenantId: TEST_TENANT,
      actor: 'user',
      actorUserId: 'u1',
      action: AuditAction.UserPasswordChange,
    });
    tick();
    await service.record({
      tenantId: TEST_TENANT,
      actor: 'superadmin',
      actorUserId: 'admin',
      action: AuditAction.AdminImpersonate,
      targetOwnerId: 'u1',
    });

    expect(repo.rows[0]?.prevHash).toBeNull();
    expect(repo.rows[1]?.prevHash).toBe(repo.rows[0]?.hash);
    expect(repo.rows[2]?.prevHash).toBe(repo.rows[1]?.hash);

    const rows = await repo.listForVerify(TEST_TENANT, 100);
    expect(verifyAuditChain(rows)).toEqual({ ok: true, checked: 3 });
  });

  it('改掉某条记录的字段，校验能报出是哪一条断了', async () => {
    const { repo, service, tick } = makeService();
    await service.record({ tenantId: TEST_TENANT, actor: 'user', action: AuditAction.CredentialUnlock });
    tick();
    await service.record({ tenantId: TEST_TENANT, actor: 'user', action: AuditAction.UserPasswordChange });
    tick();
    await service.record({ tenantId: TEST_TENANT, actor: 'user', action: AuditAction.CredentialLock });

    // 模拟部署者在数据库层面把"改密码"改成了别的动作
    repo.corrupt(1, { action: AuditAction.CredentialCreate });

    const rows = await repo.listForVerify(TEST_TENANT, 100);
    const result = verifyAuditChain(rows);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.index).toBe(1);
      expect(result.brokenAtId).toBe('audit-002');
      expect(result.reason).toContain('hash');
    }
  });

  it('删掉中间一条记录，后续记录因 prevHash 不衔接而暴露', async () => {
    const { repo, service, tick } = makeService();
    for (let i = 0; i < 3; i += 1) {
      await service.record({ tenantId: TEST_TENANT, actor: 'user', action: AuditAction.CredentialUnlock });
      tick();
    }

    repo.removeAt(1);

    const rows = await repo.listForVerify(TEST_TENANT, 100);
    const result = verifyAuditChain(rows);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.index).toBe(1);
      expect(result.reason).toContain('prevHash');
    }
  });

  it('createdAt 参与哈希：改时间等同于改内容', () => {
    const base = {
      prevHash: null,
      actorUserId: 'u1',
      actor: 'user',
      action: AuditAction.CredentialUnlock,
      target: null,
      targetOwnerId: null,
      ip: null,
      beforeJson: null,
      afterJson: null,
      createdAt: new Date('2026-10-23T10:00:00Z'),
    };
    const h1 = computeAuditHash(base);
    const h2 = computeAuditHash({ ...base, createdAt: new Date('2026-10-23T10:00:01Z') });
    expect(h1).not.toBe(h2);
  });

  it('payload 里的密钥字段被兜底裁剪，不会写进审计', async () => {
    const { repo, service } = makeService();
    await service.record({
      tenantId: TEST_TENANT,
      actor: 'user',
      action: AuditAction.CredentialCreate,
      after: {
        label: '我的 DeepSeek',
        apiKey: 'sk-live-should-never-appear',
        apiKeyEnc: 'dek:v1:aaaa:bbbb:cccc',
        nested: { accessToken: 'napcat-token' },
        enabled: true,
      },
    });

    const row = repo.rows[0];
    expect(row?.afterJson).toContain('[redacted]');
    expect(row?.afterJson).toContain('我的 DeepSeek');
    expect(row?.afterJson).not.toContain('sk-live-should-never-appear');
    expect(row?.afterJson).not.toContain('napcat-token');
    expect(row?.afterJson).not.toContain('dek:v1:');
  });

  it('toAuditJson 把 undefined 与 null 统一成 null，避免出现两种"空"', () => {
    expect(toAuditJson(undefined)).toBeNull();
    expect(toAuditJson(null)).toBeNull();
    expect(toAuditJson({ a: 1 })).toBe('{"a":1}');
  });

  it('时钟停在同一毫秒时 createdAt 仍严格递增（否则按时间重算链会误报断链）', async () => {
    const repo = new FakeAuditRepository();
    const frozen = new Date('2026-10-23T10:00:00.000Z');
    const service = new AuditService(repo, () => frozen);

    await service.record({ tenantId: TEST_TENANT, actor: 'user', action: AuditAction.CredentialUnlock });
    await service.record({ tenantId: TEST_TENANT, actor: 'user', action: AuditAction.CredentialLock });
    await service.record({ tenantId: TEST_TENANT, actor: 'user', action: AuditAction.CredentialUnlock });

    const times = repo.rows.map((row) => row.createdAt.getTime());
    expect(times[1]!).toBeGreaterThan(times[0]!);
    expect(times[2]!).toBeGreaterThan(times[1]!);

    const rows = await repo.listForVerify(TEST_TENANT, 100);
    expect(verifyAuditChain(rows).ok).toBe(true);
  });

  it('进程重启（新实例）且时钟回拨时，链仍然完整', async () => {
    const repo = new FakeAuditRepository();
    const later = new Date('2026-10-23T12:00:00.000Z');
    const first = new AuditService(repo, () => later);
    await first.record({ tenantId: TEST_TENANT, actor: 'user', action: AuditAction.CredentialUnlock });
    await first.record({ tenantId: TEST_TENANT, actor: 'user', action: AuditAction.CredentialLock });

    // 模拟重启：新实例、时钟比库里最后一条还早（NTP 回拨 / 容器时钟漂移）
    const earlier = new Date('2026-10-23T10:00:00.000Z');
    const restarted = new AuditService(repo, () => earlier);
    await restarted.record({ tenantId: TEST_TENANT, actor: 'user', action: AuditAction.CredentialUnlock });

    const rows = await repo.listForVerify(TEST_TENANT, 100);
    // 新记录必须排在历史记录之后，否则按时间重算链会误报断链
    expect(rows[2]!.createdAt.getTime()).toBeGreaterThan(rows[1]!.createdAt.getTime());
    expect(verifyAuditChain(rows).ok).toBe(true);
  });

  it('并发追加不会让链分叉（进程内串行）', async () => {
    const { repo, service } = makeService();
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        service.record({
          tenantId: TEST_TENANT,
          actor: 'system',
          action: AuditAction.CredentialUnlock,
          target: `n-${i}`,
        }),
      ),
    );

    const rows = await repo.listForVerify(TEST_TENANT, 100);
    expect(rows).toHaveLength(6);
    expect(verifyAuditChain(rows).ok).toBe(true);
  });
});
