/**
 * 凭据仓储的安全属性测试。
 *
 * 不连数据库，而是**记录 Prisma 实际收到的参数**：
 * 这里要证明的是"归属过滤下推到 SQL 了"，不是"内存里过滤一下也对"。
 * 前者是隔离，后者是把别人的数据捞出来再假装看不见。
 */

import { Prisma, type PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { CredentialCreateInput } from '@/modules/credential/ports';
import { PrismaCredentialRepository } from '@/modules/credential/repositories/prisma-credential.repository';

const OWNER = 'user-alice';
const OTHER_ID = 'cred-of-bob';

const ROW = {
  id: 'cred-1',
  provider: 'deepseek',
  label: '我的 DeepSeek',
  ownerLabel: null,
  baseUrl: null,
  authStyle: 'bearer',
  apiVersion: null,
  keyMasked: 'sk-****cdef',
  defaultModel: null,
  dailyBudgetCents: 0,
  monthlyBudgetCents: 0,
  priority: 100,
  enabled: true,
  disabledBy: null,
  lastCheckedAt: null,
  lastCheckOk: null,
  lastError: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

type Call = { method: string; args: Record<string, unknown> };

function makePrisma(updateError?: unknown) {
  const calls: Call[] = [];
  const record = (method: string, args: Record<string, unknown>, result: unknown): unknown => {
    calls.push({ method, args });
    return result;
  };

  const delegate = {
    create: async (args: Record<string, unknown>) => record('create', args, ROW),
    findMany: async (args: Record<string, unknown>) => record('findMany', args, [ROW]),
    findFirst: async (args: Record<string, unknown>) => record('findFirst', args, ROW),
    update: async (args: Record<string, unknown>) => {
      calls.push({ method: 'update', args });
      if (updateError) {
        throw updateError;
      }
      return ROW;
    },
    deleteMany: async (args: Record<string, unknown>) => record('deleteMany', args, { count: 1 }),
    count: async (args: Record<string, unknown>) => record('count', args, 3),
  };

  const prisma = { credential: delegate } as unknown as PrismaClient;
  return { prisma, calls };
}

const CREATE_INPUT: CredentialCreateInput = {
  tenantId: 'tenant-1',
  ownerUserId: OWNER,
  provider: 'deepseek',
  label: '我的 DeepSeek',
  apiKeyEnc: 'dek:v1:aaa:bbb:ccc',
  keyMasked: 'sk-****cdef',
};

describe('PrismaCredentialRepository 归属隔离', () => {
  it('exposes no owner-less lookup (no findById / findMany)', () => {
    const repo = new PrismaCredentialRepository(makePrisma().prisma);
    // 方法名里必须带 ForUser：没有 userId 的查询方法在类型层面就不存在
    expect('findById' in repo).toBe(false);
    expect('findMany' in repo).toBe(false);
    expect(typeof repo.findForUser).toBe('function');
  });

  it('locks list queries to ownerUserId and never selects the ciphertext', async () => {
    const { prisma, calls } = makePrisma();
    const repo = new PrismaCredentialRepository(prisma);

    await repo.listForUser(OWNER);

    const args = calls[0]!.args as { where: Record<string, unknown>; select: Record<string, unknown> };
    expect(args.where).toEqual({ ownerUserId: OWNER });
    expect(args.select.apiKeyEnc).toBeUndefined();
  });

  it('scopes find by both id and ownerUserId', async () => {
    const { prisma, calls } = makePrisma();
    const repo = new PrismaCredentialRepository(prisma);

    await repo.findForUser(OWNER, OTHER_ID);

    const args = calls[0]!.args as { where: Record<string, unknown> };
    expect(args.where).toEqual({ id: OTHER_ID, ownerUserId: OWNER });
  });

  it('scopes update by both id and ownerUserId in a single statement', async () => {
    const { prisma, calls } = makePrisma();
    const repo = new PrismaCredentialRepository(prisma);

    await repo.updateForUser(OWNER, OTHER_ID, { label: '改名' });

    expect(calls).toHaveLength(1);
    const args = calls[0]!.args as { where: Record<string, unknown>; data: Record<string, unknown> };
    expect(calls[0]!.method).toBe('update');
    expect(args.where).toEqual({ id: OTHER_ID, ownerUserId: OWNER });
    expect(args.data).toEqual({ label: '改名' });
  });

  it('treats "exists but not yours" as not found (P2025 -> null)', async () => {
    const p2025 = new Prisma.PrismaClientKnownRequestError('Record to update not found', {
      code: 'P2025',
      clientVersion: 'test',
    });
    const { prisma } = makePrisma(p2025);
    const repo = new PrismaCredentialRepository(prisma);

    await expect(repo.updateForUser(OWNER, OTHER_ID, { label: '越权改名' })).resolves.toBeNull();
  });

  it('deletes with a filtered deleteMany, never an unfiltered delete', async () => {
    const { prisma, calls } = makePrisma();
    const repo = new PrismaCredentialRepository(prisma);

    await expect(repo.deleteForUser(OWNER, OTHER_ID)).resolves.toBe(true);

    expect(calls[0]!.method).toBe('deleteMany');
    const args = calls[0]!.args as { where: Record<string, unknown> };
    expect(args.where).toEqual({ id: OTHER_ID, ownerUserId: OWNER });
  });

  it('creates with the owner from the argument, and returns a row without ciphertext', async () => {
    const { prisma, calls } = makePrisma();
    const repo = new PrismaCredentialRepository(prisma);

    const row = await repo.createForUser(CREATE_INPUT);

    const args = calls[0]!.args as { data: Record<string, unknown>; select: Record<string, unknown> };
    expect(args.data.ownerUserId).toBe(OWNER);
    expect(args.data.apiKeyEnc).toBe('dek:v1:aaa:bbb:ccc');
    expect(args.select.apiKeyEnc).toBeUndefined();
    expect(row).not.toHaveProperty('apiKeyEnc');
  });
});
