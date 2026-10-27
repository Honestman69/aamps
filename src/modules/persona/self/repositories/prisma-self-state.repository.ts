/**
 * 人格演化的 Prisma 仓储（M5-2）。
 *
 * 四个细节值得留意：
 *   1. `load` 只读不建 —— 「没演化过」和「演化到中性值」是两件事，前者不该在库里留痕；
 *   2. `applyVersion` 用事务包住"追加快照 + 更新当前"，避免一半成功；
 *   3. `deltasSince` 把当天各版的 `deltasJson` 按维度求和 —— 不能靠比较首尾版本，
 *      因为中间可能回滚过（回滚不产生变化量，但会改变数值）；
 *   4. 所有查询都不接受"只有 instanceId"的入口：归属校验由服务层用
 *      `isInstanceOwned` 先做一次，避免"拿到 id 就能改别人的性格"。
 */

import type { PrismaClient } from '@prisma/client';

import { parseTraits, TRAITS, type TraitKey, type Traits } from '../evolution';
import type {
  ApplyVersionInput,
  ISelfStateRepository,
  SelfStateRow,
  SelfVersionRow,
} from '../ports';

type StateRow = {
  instanceId: string;
  traitsJson: string;
  narrative: string;
  version: number;
  updatedAt: Date;
};

type VersionRow = {
  version: number;
  traitsJson: string;
  narrative: string;
  deltasJson: string;
  reason: string;
  sourceMemoryIds: string | null;
  createdAt: Date;
};

function toState(row: StateRow): SelfStateRow {
  return {
    instanceId: row.instanceId,
    traits: parseTraits(row.traitsJson),
    narrative: row.narrative,
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

function parseDeltas(json: string): Partial<Record<TraitKey, number>> {
  const result: Partial<Record<TraitKey, number>> = {};
  if (!json) {
    return result;
  }
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    for (const key of TRAITS) {
      const value = parsed[key];
      if (typeof value === 'number' && Number.isFinite(value) && value !== 0) {
        result[key] = value;
      }
    }
  } catch {
    // 坏 JSON 当作"没有变化量"：它只影响单日预算的精度，不该让整次演化失败
  }
  return result;
}

function toVersion(row: VersionRow): SelfVersionRow {
  return {
    version: row.version,
    traits: parseTraits(row.traitsJson),
    narrative: row.narrative,
    deltas: parseDeltas(row.deltasJson),
    reason: row.reason,
    sourceMemoryIds: row.sourceMemoryIds,
    createdAt: row.createdAt,
  };
}

export class PrismaSelfStateRepository implements ISelfStateRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async load(instanceId: string): Promise<SelfStateRow | null> {
    const row = await this.prisma.selfState.findUnique({
      where: { instanceId },
      select: {
        instanceId: true,
        traitsJson: true,
        narrative: true,
        version: true,
        updatedAt: true,
      },
    });
    return row ? toState(row) : null;
  }

  async isInstanceOwned(instanceId: string, userId: string): Promise<boolean> {
    const count = await this.prisma.botInstance.count({ where: { id: instanceId, ownerUserId: userId } });
    return count > 0;
  }

  async findInstance(
    instanceId: string,
  ): Promise<{ tenantId: string; ownerUserId: string } | null> {
    const row = await this.prisma.botInstance.findUnique({
      where: { id: instanceId },
      select: { tenantId: true, ownerUserId: true },
    });
    return row ?? null;
  }

  async deltasSince(
    instanceId: string,
    since: Date,
  ): Promise<Partial<Record<TraitKey, number>>> {
    const rows = await this.prisma.selfStateVersion.findMany({
      where: { instanceId, createdAt: { gte: since } },
      select: { deltasJson: true },
    });
    const totals: Partial<Record<TraitKey, number>> = {};
    for (const row of rows) {
      const deltas = parseDeltas(row.deltasJson);
      for (const key of TRAITS) {
        const value = deltas[key];
        if (value !== undefined) {
          totals[key] = Number(((totals[key] ?? 0) + value).toFixed(4));
        }
      }
    }
    return totals;
  }

  async applyVersion(input: ApplyVersionInput): Promise<SelfStateRow> {
    const [state] = await this.prisma.$transaction([
      this.prisma.selfState.upsert({
        where: { instanceId: input.instanceId },
        create: {
          instanceId: input.instanceId,
          traitsJson: JSON.stringify(input.traits),
          narrative: input.narrative,
          version: input.version,
        },
        update: {
          traitsJson: JSON.stringify(input.traits),
          narrative: input.narrative,
          version: input.version,
        },
        select: {
          instanceId: true,
          traitsJson: true,
          narrative: true,
          version: true,
          updatedAt: true,
        },
      }),
      this.prisma.selfStateVersion.create({
        data: {
          instanceId: input.instanceId,
          version: input.version,
          traitsJson: JSON.stringify(input.traits),
          narrative: input.narrative,
          deltasJson: JSON.stringify(input.deltas),
          reason: input.reason,
          sourceMemoryIds: input.sourceMemoryIds,
        },
      }),
    ]);
    return toState(state);
  }

  async listVersions(instanceId: string, limit: number): Promise<SelfVersionRow[]> {
    const rows = await this.prisma.selfStateVersion.findMany({
      where: { instanceId },
      orderBy: { version: 'desc' },
      take: limit,
      select: {
        version: true,
        traitsJson: true,
        narrative: true,
        deltasJson: true,
        reason: true,
        sourceMemoryIds: true,
        createdAt: true,
      },
    });
    return rows.map(toVersion);
  }

  async findVersion(instanceId: string, version: number): Promise<SelfVersionRow | null> {
    const row = await this.prisma.selfStateVersion.findUnique({
      where: { instanceId_version: { instanceId, version } },
      select: {
        version: true,
        traitsJson: true,
        narrative: true,
        deltasJson: true,
        reason: true,
        sourceMemoryIds: true,
        createdAt: true,
      },
    });
    return row ? toVersion(row) : null;
  }
}
