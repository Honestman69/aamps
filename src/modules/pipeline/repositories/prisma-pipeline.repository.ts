/**
 * Pipeline 取数的 Prisma 实现。
 */

import type { PrismaClient } from '@prisma/client';

import type { ActivePersona, InstanceOwner, IPipelineRepository } from '../ports';

export class PrismaPipelineRepository implements IPipelineRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findOwner(instanceId: string): Promise<InstanceOwner | null> {
    const row = await this.prisma.botInstance.findUnique({
      where: { id: instanceId },
      select: { id: true, ownerUserId: true, name: true, accountId: true, silentUntil: true },
    });
    if (!row) {
      return null;
    }
    return {
      instanceId: row.id,
      ownerUserId: row.ownerUserId,
      name: row.name,
      accountId: row.accountId,
      silentUntil: row.silentUntil,
    };
  }

  async findActivePersona(instanceId: string): Promise<ActivePersona | null> {
    const instance = await this.prisma.botInstance.findUnique({
      where: { id: instanceId },
      select: { activePersonaId: true },
    });
    if (!instance?.activePersonaId) {
      return null;
    }
    const persona = await this.prisma.persona.findUnique({
      where: { id: instance.activePersonaId },
      select: {
        name: true,
        tagline: true,
        identityJson: true,
        promptBlocksJson: true,
        examplesJson: true,
        boundariesJson: true,
        fallbacksJson: true,
        quoteTendency: true,
        behaviorJson: true,
      },
    });
    if (!persona) {
      return null;
    }
    return persona;
  }
}
