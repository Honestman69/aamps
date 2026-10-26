import { describe, expect, it } from 'vitest';

import { AppError } from '@newjob/contracts';

import { AuditAction } from '@/modules/auth/audit.service';
import type { IPersonaRepository, PersonaCreateInput, PersonaRow, PersonaUpdatePatch } from '@/modules/persona/ports';
import { PersonaService, type PersonaActor } from '@/modules/persona/persona.service';

const ACTOR: PersonaActor = {
  sessionId: 's1',
  userId: 'u1',
  tenantId: 't1',
  role: 'user',
  ip: null,
};

const NOW = new Date('2026-10-26T10:00:00');

function row(overrides: Partial<PersonaRow> = {}): PersonaRow {
  return {
    id: 'p1',
    instanceId: 'i1',
    name: '小雅',
    avatar: null,
    tagline: null,
    identityJson: '{}',
    promptBlocksJson: '[]',
    examplesJson: '[]',
    openingJson: '{}',
    boundariesJson: '[]',
    variablesJson: '{}',
    behaviorJson: '{}',
    fallbacksJson: '{}',
    quoteTendency: 'normal',
    version: 1,
    status: 'draft',
    publishedAt: null,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

class FakeRepo implements IPersonaRepository {
  rows: PersonaRow[] = [row()];
  instances = new Map<string, { ownerUserId: string; activePersonaId: string | null }>([
    ['i1', { ownerUserId: 'u1', activePersonaId: null }],
    ['i2', { ownerUserId: 'u2', activePersonaId: null }],
  ]);
  snapshots: Array<{ id: string; publishedSnapshot: string | null }> = [];

  async listForInstance(instanceId: string, includeArchived: boolean): Promise<PersonaRow[]> {
    return this.rows.filter(
      (item) => item.instanceId === instanceId && (includeArchived || item.status !== 'archived'),
    );
  }
  async findForUser(userId: string, personaId: string): Promise<PersonaRow | null> {
    const found = this.rows.find((item) => item.id === personaId);
    if (!found) return null;
    return this.instances.get(found.instanceId)?.ownerUserId === userId ? found : null;
  }
  async findInstanceForUser(userId: string, instanceId: string) {
    const instance = this.instances.get(instanceId);
    if (!instance || instance.ownerUserId !== userId) return null;
    return { id: instanceId, activePersonaId: instance.activePersonaId };
  }
  async create(input: PersonaCreateInput): Promise<PersonaRow> {
    const created = row({
      id: `p${this.rows.length + 1}`,
      instanceId: input.instanceId,
      name: input.name,
      avatar: input.avatar ?? null,
      tagline: input.tagline ?? null,
      identityJson: input.identityJson ?? '{}',
      behaviorJson: input.behaviorJson ?? '{}',
      quoteTendency: input.quoteTendency ?? 'normal',
      status: 'draft',
      version: 1,
    });
    this.rows.push(created);
    return created;
  }
  async update(personaId: string, patch: PersonaUpdatePatch): Promise<PersonaRow> {
    const index = this.rows.findIndex((item) => item.id === personaId);
    const current = this.rows[index] as PersonaRow;
    const { publishedSnapshot, ...rest } = patch;
    if (publishedSnapshot !== undefined) {
      this.snapshots.push({ id: personaId, publishedSnapshot });
    }
    const next = { ...current, ...rest, updatedAt: NOW } as PersonaRow;
    this.rows[index] = next;
    return next;
  }
  async setActivePersona(instanceId: string, personaId: string | null): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (instance) instance.activePersonaId = personaId;
  }
}

class FakeAudit {
  calls: Array<{ action: string }> = [];
  async record(input: { action: string }): Promise<never> {
    this.calls.push({ action: input.action });
    return undefined as never;
  }
}

function makeService(seed?: PersonaRow[]) {
  const repo = new FakeRepo();
  if (seed) repo.rows = seed;
  const audit = new FakeAudit();
  const service = new PersonaService({
    personas: repo,
    audit: audit as never,
    clock: () => NOW,
  });
  return { repo, audit, service };
}

describe('PersonaService 创建与读取', () => {
  it('创建草稿：对象字段被序列化进库，出参又是对象', async () => {
    const { service, repo, audit } = makeService();

    const dto = await service.create(ACTOR, 'i1', {
      name: '阿雅',
      identity: { name: '阿雅', age: '22' },
      behavior: { expression: { typingCps: 6 } },
    });

    expect(dto.status).toBe('draft');
    expect(dto.version).toBe(1);
    expect(dto.identity.name).toBe('阿雅');
    expect(dto.behavior.expression).toEqual({ typingCps: 6 });
    expect(repo.rows.some((item) => item.name === '阿雅')).toBe(true);
    expect(audit.calls.map((call) => call.action)).toContain(AuditAction.PersonaCreate);
  });

  it('别人的实例 → 404（不存在与无权限同一句）', async () => {
    const { service } = makeService();
    await expect(service.create(ACTOR, 'i2', { name: 'x' })).rejects.toMatchObject({
      code: 'INSTANCE_NOT_FOUND',
      httpStatus: 404,
    });
  });

  it('别人的 personaId → 404', async () => {
    const { service, repo } = makeService([row({ id: 'p9', instanceId: 'i2' })]);
    expect(repo.rows).toHaveLength(1);
    await expect(service.get(ACTOR, 'p9')).rejects.toBeInstanceOf(AppError);
    await expect(service.get(ACTOR, 'p9')).rejects.toMatchObject({ code: 'PERSONA_NOT_FOUND' });
  });

  it('列表默认不含归档，includeArchived 才带出来', async () => {
    const { service } = makeService([
      row({ id: 'p1', status: 'published' }),
      row({ id: 'p2', status: 'archived' }),
    ]);

    const visible = await service.list(ACTOR, 'i1', { includeArchived: false });
    const all = await service.list(ACTOR, 'i1', { includeArchived: true });
    expect(visible.map((item) => item.id)).toEqual(['p1']);
    expect(all.map((item) => item.id).sort()).toEqual(['p1', 'p2']);
  });
});

describe('PersonaService 编辑与版本', () => {
  it('改草稿不涨版本（改十次措辞不该变成 v11）', async () => {
    const { service } = makeService([row({ status: 'draft', version: 1 })]);
    const dto = await service.update(ACTOR, 'p1', { tagline: '改了一句' });
    expect(dto.version).toBe(1);
    expect(dto.tagline).toBe('改了一句');
  });

  it('改已发布的人设：版本 +1，并刷新发布快照', async () => {
    const { service, repo } = makeService([row({ status: 'published', version: 3 })]);

    const dto = await service.update(ACTOR, 'p1', { tagline: '新说法' });

    expect(dto.version).toBe(4);
    // 快照要跟着改后的内容走，否则"回滚"会回到一个没人记得的中间态
    expect(repo.snapshots.at(-1)?.publishedSnapshot).toContain('新说法');
  });

  it('归档的人设不能再改（409）', async () => {
    const { service } = makeService([row({ status: 'archived' })]);
    await expect(service.update(ACTOR, 'p1', { name: 'x' })).rejects.toMatchObject({
      code: 'PERSONA_ARCHIVED',
      httpStatus: 409,
    });
  });
});

describe('PersonaService 发布 / 归档 / 启用', () => {
  it('发布是幂等的：再点一次不会改掉首次发布时间', async () => {
    const { service } = makeService([row({ status: 'draft' })]);
    const first = await service.publish(ACTOR, 'p1');
    const second = await service.publish(ACTOR, 'p1');
    expect(first.publishedAt).toBe(NOW.toISOString());
    expect(second.publishedAt).toBe(first.publishedAt);
    expect(second.status).toBe('published');
  });

  it('草稿不能启用（409 提示先发布）', async () => {
    const { service } = makeService([row({ status: 'draft' })]);
    await expect(service.activate(ACTOR, 'p1')).rejects.toMatchObject({
      code: 'PERSONA_NOT_PUBLISHED',
      httpStatus: 409,
    });
  });

  it('启用已发布人设：instance.activePersonaId 指向它', async () => {
    const { service, repo } = makeService([row({ status: 'published' })]);
    const dto = await service.activate(ACTOR, 'p1');
    expect(dto.active).toBe(true);
    expect(repo.instances.get('i1')?.activePersonaId).toBe('p1');
  });

  it('归档当前生效的人设：同时解除激活（不留"归档内容还在生效"）', async () => {
    const { service, repo } = makeService([row({ status: 'published' })]);
    repo.instances.get('i1')!.activePersonaId = 'p1';

    const dto = await service.archive(ACTOR, 'p1');

    expect(dto.status).toBe('archived');
    expect(dto.active).toBe(false);
    expect(repo.instances.get('i1')?.activePersonaId).toBeNull();
  });

  it('重复归档幂等，不重复写审计', async () => {
    const { service, audit } = makeService([row({ status: 'archived' })]);
    await service.archive(ACTOR, 'p1');
    expect(audit.calls.filter((call) => call.action === AuditAction.PersonaArchive)).toHaveLength(0);
  });

  it('每个写动作都留审计', async () => {
    const { service, audit } = makeService([row({ status: 'draft' })]);
    await service.create(ACTOR, 'i1', { name: '第二份' });
    await service.update(ACTOR, 'p1', { tagline: 'x' });
    await service.publish(ACTOR, 'p1');
    await service.activate(ACTOR, 'p1');
    await service.archive(ACTOR, 'p1');

    expect(audit.calls.map((call) => call.action)).toEqual([
      AuditAction.PersonaCreate,
      AuditAction.PersonaUpdate,
      AuditAction.PersonaPublish,
      AuditAction.PersonaActivate,
      AuditAction.PersonaArchive,
    ]);
  });
});
