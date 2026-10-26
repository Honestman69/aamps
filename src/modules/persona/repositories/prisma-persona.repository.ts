/**
 * 人设仓储的 Prisma 实现。
 *
 * 唯一要记住的一点：**所有读都经过 `instance.ownerUserId`**。
 * 有一段历史教训（D023）是"人格归属从 Agent 改回 BotInstance"，
 * 所以这里的 where 一律写 `instance: { ownerUserId }`，而不是取出来再比。
 */

import type { PrismaClient } from '@prisma/client';

import type {
  IPersonaRepository,
  PersonaCreateInput,
  PersonaRow,
  PersonaUpdatePatch,
} from '../ports';

const SELECT = {
  id: true,
  instanceId: true,
  name: true,
  avatar: true,
  tagline: true,
  identityJson: true,
  promptBlocksJson: true,
  examplesJson: true,
  openingJson: true,
  boundariesJson: true,
  variablesJson: true,
  behaviorJson: true,
  fallbacksJson: true,
  quoteTendency: true,
  version: true,
  status: true,
  publishedAt: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export class PrismaPersonaRepository implements IPersonaRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listForInstance(instanceId: string, includeArchived: boolean): Promise<PersonaRow[]> {
    return this.prisma.persona.findMany({
      where: { instanceId, ...(includeArchived ? {} : { status: { not: 'archived' } }) },
      select: SELECT,
      // 最近改过的排前面：编辑列表里"我刚调的那份"应该在顶上
      orderBy: { updatedAt: 'desc' },
    });
  }

  async findForUser(userId: string, personaId: string): Promise<PersonaRow | null> {
    return this.prisma.persona.findFirst({
      where: { id: personaId, instance: { ownerUserId: userId } },
      select: SELECT,
    });
  }

  async findInstanceForUser(
    userId: string,
    instanceId: string,
  ): Promise<{ id: string; activePersonaId: string | null } | null> {
    return this.prisma.botInstance.findFirst({
      where: { id: instanceId, ownerUserId: userId },
      select: { id: true, activePersonaId: true },
    });
  }

  async create(input: PersonaCreateInput): Promise<PersonaRow> {
    const { instanceId, ...rest } = input;
    return this.prisma.persona.create({
      data: {
        instanceId,
        name: rest.name,
        avatar: rest.avatar ?? null,
        tagline: rest.tagline ?? null,
        ...(rest.identityJson !== undefined ? { identityJson: rest.identityJson } : {}),
        ...(rest.promptBlocksJson !== undefined ? { promptBlocksJson: rest.promptBlocksJson } : {}),
        ...(rest.examplesJson !== undefined ? { examplesJson: rest.examplesJson } : {}),
        ...(rest.openingJson !== undefined ? { openingJson: rest.openingJson } : {}),
        ...(rest.boundariesJson !== undefined ? { boundariesJson: rest.boundariesJson } : {}),
        ...(rest.variablesJson !== undefined ? { variablesJson: rest.variablesJson } : {}),
        ...(rest.behaviorJson !== undefined ? { behaviorJson: rest.behaviorJson } : {}),
        ...(rest.fallbacksJson !== undefined ? { fallbacksJson: rest.fallbacksJson } : {}),
        ...(rest.quoteTendency !== undefined ? { quoteTendency: rest.quoteTendency } : {}),
      },
      select: SELECT,
    });
  }

  async update(personaId: string, patch: PersonaUpdatePatch): Promise<PersonaRow> {
    return this.prisma.persona.update({
      where: { id: personaId },
      data: patch,
      select: SELECT,
    });
  }

  async setActivePersona(instanceId: string, personaId: string | null): Promise<void> {
    await this.prisma.botInstance.update({
      where: { id: instanceId },
      data: { activePersonaId: personaId },
    });
  }
}
