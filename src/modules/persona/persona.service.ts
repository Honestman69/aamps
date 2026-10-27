/**
 * 人设服务：M4 人设编辑器的唯一写入口。
 *
 * ## 一版人设的生命周期
 *
 * ```
 * create → draft ──publish──▶ published ──archive──▶ archived
 *              ▲                  │
 *              └── update（草稿随便改，不涨版本）  update（已发布：改动即新版，version+1）
 * ```
 *
 * **为什么没有"草稿态覆盖已发布人设"这一步**：如果改一下就把线上的人设变成草稿，
 * 机器人会在下一次消息里突然"没有生效人设"（`findActivePersona` 返回 null，prompt 退化成一句默认话）。
 * 那比"改动立刻生效"更危险。所以 published 的编辑**直接生效并升版本**，
 * 想试错就先 `create` 一份新的。
 *
 * ## 为什么归档会顺手解除激活
 *
 * `BotInstance.activePersonaId` 是个唯一指针。归档了还指着它，就等于"这个号的人格被删了但还被引用"，
 * 排查时看到的是一个 archived 的人设在生效 —— 不如归档时就断开，让主链路退化成"没有人设"
 * （`assemblePrompt` 有兜底），至少是自洽的状态。
 *
 * ## 版本号只在"发布/改已发布"时涨
 *
 * 草稿阶段反复改不该涨版本：否则用户改十次措辞，版本号跳到 11，而这个数字对回滚毫无意义。
 */

import { AppError } from '@newjob/contracts';

import { AuditAction, AuditService, type AuditActor } from '../auth/audit.service';
import {
  serializeJsonField,
  toPersonaDTO,
  type CreatePersonaInput,
  type PersonaPublicDTO,
  type UpdatePersonaInput,
} from './dto';
import type { IPersonaRepository, PersonaRow, PersonaUpdatePatch } from './ports';

export type PersonaActor = {
  sessionId: string;
  userId: string;
  tenantId: string;
  role: string;
  ip?: string | null;
};

export type PersonaServiceDeps = {
  personas: IPersonaRepository;
  audit: AuditService;
  clock?: () => Date;
};

function instanceNotFound(): AppError {
  return new AppError('INSTANCE_NOT_FOUND', '实例不存在', 404);
}

/** 跨用户与真不存在返回同一句：不泄漏"这条人设存在但不是你的" */
function personaNotFound(): AppError {
  return new AppError('PERSONA_NOT_FOUND', '人设不存在', 404);
}

function archivedConflict(): AppError {
  return new AppError('PERSONA_ARCHIVED', '该人设已归档，不能再修改或启用', 409);
}

function notPublishedConflict(): AppError {
  return new AppError('PERSONA_NOT_PUBLISHED', '只有已发布的人设才能启用，请先发布草稿', 409);
}

function auditActor(role: string): Extract<AuditActor, 'superadmin' | 'user'> {
  return role === 'superadmin' ? 'superadmin' : 'user';
}

/** 只放不敏感、可读的字段进审计：**人设内容不进审计**（可能很长，也可能含私人设定） */
function auditSummary(row: PersonaRow): Record<string, unknown> {
  return { name: row.name, status: row.status, version: row.version };
}

export class PersonaService {
  constructor(private readonly deps: PersonaServiceDeps) {}

  private now(): Date {
    return this.deps.clock?.() ?? new Date();
  }

  private async instanceOf(actor: PersonaActor, instanceId: string) {
    const instance = await this.deps.personas.findInstanceForUser(actor.userId, instanceId);
    if (!instance) {
      throw instanceNotFound();
    }
    return instance;
  }

  private async personaOf(actor: PersonaActor, personaId: string): Promise<PersonaRow> {
    const row = await this.deps.personas.findForUser(actor.userId, personaId);
    if (!row) {
      throw personaNotFound();
    }
    return row;
  }

  private async withActive(actor: PersonaActor, row: PersonaRow): Promise<PersonaPublicDTO> {
    const instance = await this.deps.personas.findInstanceForUser(actor.userId, row.instanceId);
    return toPersonaDTO(row, instance?.activePersonaId ?? null);
  }

  private async record(
    actor: PersonaActor,
    action: AuditAction,
    row: PersonaRow,
    before?: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record({
      tenantId: actor.tenantId,
      actor: auditActor(actor.role),
      actorUserId: actor.userId,
      action,
      target: row.id,
      targetOwnerId: actor.userId,
      ip: actor.ip ?? null,
      ...(before ? { before } : {}),
      after: auditSummary(row),
    });
  }

  async list(
    actor: PersonaActor,
    instanceId: string,
    options: { includeArchived: boolean },
  ): Promise<PersonaPublicDTO[]> {
    const instance = await this.instanceOf(actor, instanceId);
    const rows = await this.deps.personas.listForInstance(instanceId, options.includeArchived);
    return rows.map((row) => toPersonaDTO(row, instance.activePersonaId));
  }

  async get(actor: PersonaActor, personaId: string): Promise<PersonaPublicDTO> {
    return this.withActive(actor, await this.personaOf(actor, personaId));
  }

  async create(
    actor: PersonaActor,
    instanceId: string,
    input: CreatePersonaInput,
  ): Promise<PersonaPublicDTO> {
    await this.instanceOf(actor, instanceId);

    const row = await this.deps.personas.create({
      instanceId,
      name: input.name,
      avatar: input.avatar ?? null,
      tagline: input.tagline ?? null,
      identityJson: serializeJsonField(input.identity),
      promptBlocksJson: serializeJsonField(input.promptBlocks),
      examplesJson: serializeJsonField(input.examples),
      openingJson: serializeJsonField(input.opening),
      boundariesJson: serializeJsonField(input.boundaries),
      variablesJson: serializeJsonField(input.variables),
      behaviorJson: serializeJsonField(input.behavior),
      fallbacksJson: serializeJsonField(input.fallbacks),
      ...(input.quoteTendency ? { quoteTendency: input.quoteTendency } : {}),
    });

    await this.record(actor, AuditAction.PersonaCreate, row);
    return this.withActive(actor, row);
  }

  async update(
    actor: PersonaActor,
    personaId: string,
    input: UpdatePersonaInput,
  ): Promise<PersonaPublicDTO> {
    const existing = await this.personaOf(actor, personaId);
    if (existing.status === 'archived') {
      throw archivedConflict();
    }

    const patch: PersonaUpdatePatch = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.avatar !== undefined) patch.avatar = input.avatar;
    if (input.tagline !== undefined) patch.tagline = input.tagline;
    if (input.identity !== undefined) patch.identityJson = serializeJsonField(input.identity);
    if (input.promptBlocks !== undefined) patch.promptBlocksJson = serializeJsonField(input.promptBlocks);
    if (input.examples !== undefined) patch.examplesJson = serializeJsonField(input.examples);
    if (input.opening !== undefined) patch.openingJson = serializeJsonField(input.opening);
    if (input.boundaries !== undefined) patch.boundariesJson = serializeJsonField(input.boundaries);
    if (input.variables !== undefined) patch.variablesJson = serializeJsonField(input.variables);
    if (input.behavior !== undefined) patch.behaviorJson = serializeJsonField(input.behavior);
    if (input.fallbacks !== undefined) patch.fallbacksJson = serializeJsonField(input.fallbacks);
    if (input.quoteTendency !== undefined) patch.quoteTendency = input.quoteTendency;

    // 已发布的人设改一次就是新版本，并把发布快照刷新成改后的内容（否则"回滚"会回到一个没人记得的中间态）
    const isPublished = existing.status === 'published';
    if (isPublished) {
      patch.version = existing.version + 1;
    }

    let row = await this.deps.personas.update(personaId, patch);
    if (isPublished) {
      row = await this.deps.personas.update(personaId, { publishedSnapshot: snapshotOf(row) });
    }

    await this.record(actor, AuditAction.PersonaUpdate, row, auditSummary(existing));
    return this.withActive(actor, row);
  }

  async publish(actor: PersonaActor, personaId: string): Promise<PersonaPublicDTO> {
    const existing = await this.personaOf(actor, personaId);
    if (existing.status === 'archived') {
      throw archivedConflict();
    }

    // 重复发布是幂等的：publishedAt 只在第一次落，不让"再点一次发布"改掉首次发布时间
    const row = await this.deps.personas.update(personaId, {
      status: 'published',
      publishedAt: existing.publishedAt ?? this.now(),
      publishedSnapshot: snapshotOf(existing),
    });

    await this.record(actor, AuditAction.PersonaPublish, row, auditSummary(existing));
    return this.withActive(actor, row);
  }

  async archive(actor: PersonaActor, personaId: string): Promise<PersonaPublicDTO> {
    const existing = await this.personaOf(actor, personaId);
    if (existing.status === 'archived') {
      // 幂等：再归档一次不算错，但也不重复写审计
      return this.withActive(actor, existing);
    }

    const row = await this.deps.personas.update(personaId, {
      status: 'archived',
      archivedAt: this.now(),
    });

    const instance = await this.deps.personas.findInstanceForUser(actor.userId, row.instanceId);
    if (instance?.activePersonaId === row.id) {
      // 别让实例指向一个已归档的人设：主链路会读到"归档内容还在生效"这种自相矛盾的状态
      await this.deps.personas.setActivePersona(row.instanceId, null);
    }

    await this.record(actor, AuditAction.PersonaArchive, row, auditSummary(existing));
    return this.withActive(actor, row);
  }

  async activate(actor: PersonaActor, personaId: string): Promise<PersonaPublicDTO> {
    const existing = await this.personaOf(actor, personaId);
    if (existing.status === 'archived') {
      throw archivedConflict();
    }
    if (existing.status !== 'published') {
      throw notPublishedConflict();
    }

    await this.deps.personas.setActivePersona(existing.instanceId, existing.id);
    await this.record(actor, AuditAction.PersonaActivate, existing);
    return this.withActive(actor, existing);
  }
}

/** 发布快照 = 内容字段的全量副本（不含 id / 时间戳，那些不是"设定"） */
function snapshotOf(row: PersonaRow): string {
  return JSON.stringify({
    name: row.name,
    avatar: row.avatar,
    tagline: row.tagline,
    identity: safeParse(row.identityJson, {}),
    promptBlocks: safeParse(row.promptBlocksJson, []),
    examples: safeParse(row.examplesJson, []),
    opening: safeParse(row.openingJson, {}),
    boundaries: safeParse(row.boundariesJson, []),
    variables: safeParse(row.variablesJson, {}),
    behavior: safeParse(row.behaviorJson, {}),
    fallbacks: safeParse(row.fallbacksJson, {}),
    quoteTendency: row.quoteTendency,
  });
}

function safeParse<T>(raw: string, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(raw);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}
