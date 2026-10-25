/**
 * 心智状态的 Prisma 实现。
 */

import type { PrismaClient } from '@prisma/client';

import type { MindState } from '../mind-state';
import type { RelationshipSnapshot } from '../relationship';
import type { IMindStateRepository } from '../ports';

export class PrismaMindStateRepository implements IMindStateRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async loadState(instanceId: string): Promise<MindState | null> {
    const row = await this.prisma.agentState.findUnique({
      where: { instanceId },
      select: { mood: true, energy: true, busyUntil: true, lastDecayAt: true },
    });
    return row ?? null;
  }

  async saveState(instanceId: string, state: MindState): Promise<void> {
    const data = {
      mood: state.mood,
      energy: state.energy,
      busyUntil: state.busyUntil,
      lastDecayAt: state.lastDecayAt,
    };
    await this.prisma.agentState.upsert({
      where: { instanceId },
      create: { instanceId, ...data },
      update: data,
    });
  }

  async loadRelationship(instanceId: string, peerId: string): Promise<RelationshipSnapshot | null> {
    const row = await this.prisma.relationship.findUnique({
      where: { instanceId_peerId: { instanceId, peerId } },
      select: { peerId: true, nickname: true, affinity: true, trust: true, lastInteractionAt: true },
    });
    return row ?? null;
  }

  async saveRelationship(input: {
    instanceId: string;
    peerId: string;
    nickname: string | null;
    affinity: number;
    lastInteractionAt: Date;
  }): Promise<void> {
    const affinity = Math.round(input.affinity);
    await this.prisma.relationship.upsert({
      where: { instanceId_peerId: { instanceId: input.instanceId, peerId: input.peerId } },
      create: {
        instanceId: input.instanceId,
        peerId: input.peerId,
        nickname: input.nickname,
        affinity,
        lastInteractionAt: input.lastInteractionAt,
      },
      update: {
        nickname: input.nickname,
        affinity,
        lastInteractionAt: input.lastInteractionAt,
      },
    });
  }
}
