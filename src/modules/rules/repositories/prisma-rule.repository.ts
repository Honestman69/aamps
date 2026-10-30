/**
 * 约束词的 Prisma 仓储（D051）。
 */

import type { PrismaClient } from '@prisma/client';

import type { IRuleRepository, RuleCreateInput, RulePatch, RuleRow } from '../ports';

const SELECT = {
  id: true,
  instanceId: true,
  kind: true,
  pattern: true,
  note: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
} as const;

export class PrismaRuleRepository implements IRuleRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listForInstance(instanceId: string): Promise<RuleRow[]> {
    return this.prisma.instanceRule.findMany({
      where: { instanceId },
      orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }],
      select: SELECT,
    });
  }

  async listEnabled(instanceId: string): Promise<RuleRow[]> {
    return this.prisma.instanceRule.findMany({
      where: { instanceId, enabled: true },
      select: SELECT,
    });
  }

  async create(input: RuleCreateInput): Promise<RuleRow> {
    return this.prisma.instanceRule.create({
      data: {
        instanceId: input.instanceId,
        kind: input.kind,
        pattern: input.pattern,
        note: input.note ?? null,
      },
      select: SELECT,
    });
  }

  async findForUser(userId: string, ruleId: string): Promise<RuleRow | null> {
    return this.prisma.instanceRule.findFirst({
      // 归属下推：不是"查出来再判断"，而是"查不到"
      where: { id: ruleId, instance: { ownerUserId: userId } },
      select: SELECT,
    });
  }

  async update(ruleId: string, patch: RulePatch): Promise<RuleRow> {
    return this.prisma.instanceRule.update({
      where: { id: ruleId },
      data: {
        ...(patch.pattern !== undefined ? { pattern: patch.pattern } : {}),
        ...(patch.note !== undefined ? { note: patch.note } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      },
      select: SELECT,
    });
  }

  async delete(ruleId: string): Promise<boolean> {
    const result = await this.prisma.instanceRule.deleteMany({ where: { id: ruleId } });
    return result.count > 0;
  }

  async isInstanceOwned(instanceId: string, userId: string): Promise<boolean> {
    const count = await this.prisma.botInstance.count({
      where: { id: instanceId, ownerUserId: userId },
    });
    return count > 0;
  }
}
