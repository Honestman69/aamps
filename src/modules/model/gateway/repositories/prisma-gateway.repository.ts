/**
 * Gateway 仓储。
 *
 * `listCandidates` 会带出 `apiKeyEnc` —— 这是全项目仅有的两个"读密文"入口之一
 * （另一个是实例的 findForConnect）。where 恒带 ownerUserId，避免拿到别人的 Key。
 */

import type { PrismaClient } from '@prisma/client';

import type { GatewayCandidate, IGatewayRepository, UsageRecordInput, UsageTotals } from '../ports';

export class PrismaGatewayRepository implements IGatewayRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listCandidates(ownerUserId: string): Promise<GatewayCandidate[]> {
    const now = new Date();
    const rows = await this.prisma.credential.findMany({
      where: {
        ownerUserId,
        enabled: true,
        // 冷却中的 Key 直接跳过，但记录与 enabled 一律不动（D025）
        OR: [{ cooldownUntil: null }, { cooldownUntil: { lt: now } }],
      },
      select: {
        id: true,
        provider: true,
        baseUrl: true,
        authStyle: true,
        apiVersion: true,
        catalogJson: true,
        apiKeyEnc: true,
        priority: true,
      },
      orderBy: { priority: 'asc' },
    });

    return rows.map((row) => ({
      credentialId: row.id,
      provider: row.provider,
      baseUrl: row.baseUrl,
      authStyle: row.authStyle,
      apiVersion: row.apiVersion,
      catalogJson: row.catalogJson,
      apiKeyEnc: row.apiKeyEnc,
      priority: row.priority,
    }));
  }

  async markCooldown(credentialId: string, reason: string, until: Date): Promise<void> {
    await this.prisma.credential.update({
      where: { id: credentialId },
      // 只写健康层：不清密文、不改 enabled
      data: { cooldownUntil: until, unavailableReason: reason },
    });
  }

  async recordUsage(input: UsageRecordInput): Promise<void> {
    await this.prisma.modelUsage.create({ data: input });
  }

  async usageTotals(
    instanceId: string,
    window: { dayStart: Date; monthStart: Date },
  ): Promise<UsageTotals> {
    // 三次统计都在数据库端完成，不把行拉回内存——用量表是最容易长大的表
    const [today, month, unpriced] = await Promise.all([
      this.prisma.modelUsage.aggregate({
        where: { instanceId, createdAt: { gte: window.dayStart } },
        _sum: { costCents: true },
      }),
      this.prisma.modelUsage.aggregate({
        where: { instanceId, createdAt: { gte: window.monthStart } },
        _sum: { costCents: true },
      }),
      this.prisma.modelUsage.count({
        // 0 分不一定是"没定价"（也可能是极小的调用被取整为 0），
        // 但 pricing 侧是向上取整的，真实花费为 0 的情况只可能是没价格。
        where: { instanceId, createdAt: { gte: window.monthStart }, costCents: 0 },
      }),
    ]);

    return {
      todayCents: today._sum.costCents ?? 0,
      monthCents: month._sum.costCents ?? 0,
      unpricedCalls: unpriced,
    };
  }
}
