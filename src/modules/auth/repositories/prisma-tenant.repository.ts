/**
 * 租户仓储。自用阶段只有一个 `default`，但接口留着，后期多租户不用改调用方。
 */

import type { PrismaClient } from '@prisma/client';

import type { ITenantRepository } from '../ports';

export class PrismaTenantRepository implements ITenantRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async ensureTenant(slug: string, name: string): Promise<{ id: string }> {
    return this.prisma.tenant.upsert({
      where: { slug },
      update: {},
      create: { slug, name, plan: 'self' },
      select: { id: true },
    });
  }
}
