/**
 * Gateway 仓储。
 *
 * `listCandidates` 会带出 `apiKeyEnc` —— 这是全项目仅有的两个"读密文"入口之一
 * （另一个是实例的 findForConnect）。where 恒带 ownerUserId，避免拿到别人的 Key。
 */

import type { PrismaClient } from '@prisma/client';

import type { GatewayCandidate, IGatewayRepository, UsageRecordInput } from '../ports';

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
}
