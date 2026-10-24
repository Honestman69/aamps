/**
 * 凭据服务测试。
 *
 * 覆盖 CONVENTIONS 强制要求的那条：**跨用户查询返回空 / 抛错，不能返回他人数据**。
 * 另外锁三件事：
 *   1. 落库的只有密文与掩码，明文不进 DB、不进审计、不进响应；
 *   2. 未解锁时不能写（不存在"先存着"的降级路径）；
 *   3. 解密只在测试里做一次往返校验 —— 业务代码里没有解密函数（那是 M2 Gateway 的事）。
 */

import { KeyLockedError } from '@newjob/contracts';
import { describe, expect, it } from 'vitest';

import { decryptWithDek, randomDek } from '@/common/crypto';
import { AuditService } from '@/modules/auth/audit.service';
import { RuntimeKeyStore } from '@/modules/auth/runtime-key-store';
import { CredentialService, type CredentialActor } from '@/modules/credential/credential.service';
import { maskApiKey } from '@/modules/credential/dto';
import type {
  CredentialCreateInput,
  CredentialPublicRow,
  CredentialUpdatePatch,
  ICredentialRepository,
} from '@/modules/credential/ports';

import { FakeAuditRepository } from '../helpers/auth-fakes';

const TENANT = 'tenant-1';
const ALICE = 'user-alice';
const BOB = 'user-bob';
const SESSION_ALICE = 'session-alice';
const SESSION_BOB = 'session-bob';
const PLAIN_KEY = 'sk-1234567890abcdef';

/** 内存实现，**复刻真实仓储的归属过滤**：不是本人的一律当作不存在 */
class FakeCredentialRepository implements ICredentialRepository {
  readonly created: CredentialCreateInput[] = [];
  readonly stored = new Map<string, { row: CredentialPublicRow; enc: string; ownerUserId: string }>();
  private seq = 0;
  private stamp = 0;

  private nextDate(): Date {
    this.stamp += 1;
    return new Date(Date.UTC(2026, 0, 1) + this.stamp * 1000);
  }

  async createForUser(input: CredentialCreateInput): Promise<CredentialPublicRow> {
    this.created.push({ ...input });
    this.seq += 1;
    const now = this.nextDate();
    const row: CredentialPublicRow = {
      id: `cred-${this.seq}`,
      provider: input.provider,
      label: input.label,
      ownerLabel: input.ownerLabel ?? null,
      baseUrl: input.baseUrl ?? null,
      authStyle: input.authStyle ?? 'bearer',
      apiVersion: input.apiVersion ?? null,
      keyMasked: input.keyMasked,
      defaultModel: input.defaultModel ?? null,
      dailyBudgetCents: input.dailyBudgetCents ?? 0,
      monthlyBudgetCents: input.monthlyBudgetCents ?? 0,
      priority: input.priority ?? 100,
      enabled: input.enabled ?? true,
      disabledBy: null,
      lastCheckedAt: null,
      lastCheckOk: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    this.stored.set(row.id, { row, enc: input.apiKeyEnc, ownerUserId: input.ownerUserId });
    return { ...row };
  }

  async listForUser(userId: string): Promise<CredentialPublicRow[]> {
    return [...this.stored.values()]
      .filter((entry) => entry.ownerUserId === userId)
      .map((entry) => ({ ...entry.row }));
  }

  async findForUser(userId: string, id: string): Promise<CredentialPublicRow | null> {
    const entry = this.stored.get(id);
    return entry && entry.ownerUserId === userId ? { ...entry.row } : null;
  }

  async updateForUser(
    userId: string,
    id: string,
    patch: CredentialUpdatePatch,
  ): Promise<CredentialPublicRow | null> {
    const entry = this.stored.get(id);
    if (!entry || entry.ownerUserId !== userId) {
      return null;
    }
    const { apiKeyEnc, ...rest } = patch;
    if (apiKeyEnc !== undefined) {
      entry.enc = apiKeyEnc;
    }
    Object.assign(entry.row, rest, { updatedAt: this.nextDate() });
    return { ...entry.row };
  }

  async deleteForUser(userId: string, id: string): Promise<boolean> {
    const entry = this.stored.get(id);
    if (!entry || entry.ownerUserId !== userId) {
      return false;
    }
    this.stored.delete(id);
    return true;
  }

  async countForUser(userId: string): Promise<number> {
    return [...this.stored.values()].filter((entry) => entry.ownerUserId === userId).length;
  }

  /** 测试辅助：直接读库里的密文，确认存进去的不是明文 */
  cipherOf(id: string): string | null {
    return this.stored.get(id)?.enc ?? null;
  }
}

function actor(overrides: Partial<CredentialActor> & { userId: string }): CredentialActor {
  const sessionId = overrides.userId === ALICE ? SESSION_ALICE : SESSION_BOB;
  return {
    sessionId,
    tenantId: TENANT,
    role: 'user',
    ip: '127.0.0.1',
    ...overrides,
  };
}

function setup() {
  const repo = new FakeCredentialRepository();
  const auditRepo = new FakeAuditRepository();
  const keyStore = new RuntimeKeyStore();
  const audit = new AuditService(auditRepo);
  const service = new CredentialService({ credentials: repo, keyStore, audit });
  return { repo, auditRepo, keyStore, service };
}

describe('CredentialService 写入路径', () => {
  it('encrypts with the caller DEK and never stores or returns the plaintext', async () => {
    const { repo, auditRepo, keyStore, service } = setup();
    const dek = randomDek();
    keyStore.set(SESSION_ALICE, ALICE, dek);

    const dto = await service.create(actor({ userId: ALICE }), {
      provider: 'deepseek',
      label: '我的 DeepSeek',
      apiKey: PLAIN_KEY,
    });

    const stored = repo.created[0]!;
    expect(stored.apiKeyEnc.startsWith('dek:v1:')).toBe(true);
    expect(stored.apiKeyEnc).not.toContain(PLAIN_KEY);
    // 往返校验：密文确实能用同一把 DEK 解回原文（解密只出现在测试里）
    expect(decryptWithDek(stored.apiKeyEnc, dek)).toBe(PLAIN_KEY);

    expect(dto.keyMasked).toBe('sk-****cdef');
    expect(dto).not.toHaveProperty('apiKeyEnc');
    expect(dto).not.toHaveProperty('ownerUserId');
    // 存进库的掩码本身也不能是原文
    expect(repo.cipherOf(dto.id)).not.toBe(PLAIN_KEY);

    const auditJson = JSON.stringify(auditRepo.rows.map((row) => row.afterJson));
    expect(auditRepo.rows[0]!.action).toBe('credential.create');
    expect(auditJson).not.toContain(PLAIN_KEY);
    expect(auditJson).not.toContain('dek:v1:');
  });

  it('refuses to write before the key store is unlocked', async () => {
    const { repo, service } = setup();

    await expect(
      service.create(actor({ userId: ALICE }), {
        provider: 'deepseek',
        label: '未解锁',
        apiKey: PLAIN_KEY,
      }),
    ).rejects.toBeInstanceOf(KeyLockedError);

    // 加密失败就不能留下半成品记录
    expect(repo.created).toHaveLength(0);
  });
});

describe('CredentialService 读取路径', () => {
  it('lists only the credentials owned by the caller', async () => {
    const { keyStore, service } = setup();
    keyStore.set(SESSION_ALICE, ALICE, randomDek());
    keyStore.set(SESSION_BOB, BOB, randomDek());

    await service.create(actor({ userId: ALICE }), { provider: 'deepseek', label: 'A 的', apiKey: PLAIN_KEY });
    const bobDto = await service.create(actor({ userId: BOB }), {
      provider: 'openai',
      label: 'B 的',
      apiKey: 'sk-bob-000000000000',
    });

    const aliceList = await service.list({ userId: ALICE });
    expect(aliceList).toHaveLength(1);
    expect(aliceList[0]!.label).toBe('A 的');

    const bobList = await service.list({ userId: BOB });
    expect(bobList.map((item) => item.id)).toEqual([bobDto.id]);
  });

  it('credentials of another user are not reachable even for superadmin', async () => {
    const { repo, keyStore, service } = setup();
    keyStore.set(SESSION_ALICE, ALICE, randomDek());
    keyStore.set(SESSION_BOB, BOB, randomDek());

    const bobDto = await service.create(actor({ userId: BOB }), {
      provider: 'openai',
      label: 'B 的',
      apiKey: 'sk-bob-000000000000',
    });

    // superadmin 也不能跨用户读写：权限再大也不构成"能解密"的理由
    const superadmin = actor({ userId: ALICE, role: 'superadmin' });

    await expect(
      service.update(superadmin, bobDto.id, { label: '偷改' }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_NOT_FOUND' });

    await expect(service.remove(superadmin, bobDto.id)).rejects.toMatchObject({
      code: 'CREDENTIAL_NOT_FOUND',
    });

    // 确认没被真的改掉 / 删掉
    expect(await repo.findForUser(BOB, bobDto.id)).not.toBeNull();
    const bobList = await service.list({ userId: BOB });
    expect(bobList[0]!.label).toBe('B 的');
  });
});

describe('CredentialService 更新与删除', () => {
  it('rotates the key: new ciphertext, new mask, audit action credential.rotate', async () => {
    const { repo, auditRepo, keyStore, service } = setup();
    const dek = randomDek();
    keyStore.set(SESSION_ALICE, ALICE, dek);

    const dto = await service.create(actor({ userId: ALICE }), {
      provider: 'deepseek',
      label: '轮换前',
      apiKey: PLAIN_KEY,
    });
    const before = repo.cipherOf(dto.id);

    const rotated = await service.update(actor({ userId: ALICE }), dto.id, {
      apiKey: 'sk-ffffffffffffffff',
      label: '轮换后',
    });

    expect(rotated.keyMasked).toBe('sk-****ffff');
    expect(rotated.label).toBe('轮换后');
    expect(repo.cipherOf(dto.id)).not.toBe(before);
    expect(decryptWithDek(repo.cipherOf(dto.id)!, dek)).toBe('sk-ffffffffffffffff');
    expect(auditRepo.rows.at(-1)!.action).toBe('credential.rotate');
  });

  it('metadata-only update keeps the ciphertext untouched', async () => {
    const { repo, keyStore, service } = setup();
    keyStore.set(SESSION_ALICE, ALICE, randomDek());

    const dto = await service.create(actor({ userId: ALICE }), {
      provider: 'deepseek',
      label: '只改名字',
      apiKey: PLAIN_KEY,
    });
    const before = repo.cipherOf(dto.id);

    await service.update(actor({ userId: ALICE }), dto.id, { label: '新名字' });

    expect(repo.cipherOf(dto.id)).toBe(before);
  });

  it('deletes own credential and records the mask in audit (never the ciphertext)', async () => {
    const { repo, auditRepo, keyStore, service } = setup();
    keyStore.set(SESSION_ALICE, ALICE, randomDek());

    const dto = await service.create(actor({ userId: ALICE }), {
      provider: 'deepseek',
      label: '待删',
      apiKey: PLAIN_KEY,
    });

    await expect(service.remove(actor({ userId: ALICE }), dto.id)).resolves.toEqual({ deleted: true });

    expect(await repo.findForUser(ALICE, dto.id)).toBeNull();
    const last = auditRepo.rows.at(-1)!;
    expect(last.action).toBe('credential.delete');
    expect(last.beforeJson).toContain('sk-****cdef');
    expect(last.beforeJson).not.toContain('dek:v1:');
  });
});

describe('maskApiKey', () => {
  it('keeps the vendor prefix and last 4 digits only', () => {
    expect(maskApiKey('sk-1234567890abcdef')).toBe('sk-****cdef');
  });

  it('fully masks short keys so the mask does not become the key', () => {
    expect(maskApiKey('short-key')).toBe('****');
    expect(maskApiKey('abcdefghijkl')).toBe('abc****ijkl');
  });
});
