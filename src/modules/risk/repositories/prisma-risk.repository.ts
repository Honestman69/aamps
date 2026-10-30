/**
 * 风险巡检的 Prisma 仓储（M6-1 / D048）。
 *
 * 三个要点：
 *   1. 信号查询**倒序 + 限窗**由 SQL 做（`createdAt >= since` + `order by desc`），
 *      不在应用层排序或截断；
 *   2. 落结论时只写"该写的列"：`cooldown` 只动 `silentUntil`，`readonly` 再动 `status`，
 *      `stop` 才动 `enabled` —— 一次降级不该顺手把别的状态改掉；
 *   3. 降级必留 `InstanceEvent`（`auto_degrade`）：夜里它忽然不回话，第二天要能查到原因。
 */

import type { PrismaClient } from '@prisma/client';

import type { IRiskRepository, RiskEventRow, RiskInstanceRow } from '../ports';
import type { DegradeAction, RiskSignal } from '../health';

export class PrismaRiskRepository implements IRiskRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listInstances(): Promise<RiskInstanceRow[]> {
    return this.prisma.botInstance.findMany({
      where: { enabled: true },
      select: { id: true, status: true, silentUntil: true, healthScore: true },
    });
  }

  async findInstance(instanceId: string): Promise<RiskInstanceRow | null> {
    return this.prisma.botInstance.findUnique({
      where: { id: instanceId },
      select: { id: true, status: true, silentUntil: true, healthScore: true },
    });
  }

  async isInstanceOwned(instanceId: string, userId: string): Promise<boolean> {
    const count = await this.prisma.botInstance.count({
      where: { id: instanceId, ownerUserId: userId },
    });
    return count > 0;
  }

  async listEvents(instanceId: string, limit: number): Promise<RiskEventRow[]> {
    return this.prisma.instanceEvent.findMany({
      where: { instanceId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        level: true,
        code: true,
        message: true,
        metaJson: true,
        createdAt: true,
      },
    });
  }

  async listSignals(instanceId: string, since: Date, limit: number): Promise<RiskSignal[]> {
    const rows = await this.prisma.instanceEvent.findMany({
      where: { instanceId, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { code: true, level: true, createdAt: true },
    });
    return rows;
  }

  async saveAssessment(input: {
    instanceId: string;
    score: number;
    action: DegradeAction;
    reasons: string[];
    now: Date;
  }): Promise<void> {
    const data: {
      healthScore: number;
      silentUntil?: Date;
      status?: string;
      enabled?: boolean;
    } = { healthScore: input.score };

    if (input.action.kind === 'cooldown' || input.action.kind === 'readonly') {
      data.silentUntil = input.action.until;
    }
    if (input.action.kind === 'readonly') {
      // 连接保留、只收不发：看板上是 risk，人一眼能看出"它在被压着"
      data.status = 'risk';
    }
    if (input.action.kind === 'stop') {
      data.status = 'banned';
      data.enabled = false;
    }

    await this.prisma.$transaction([
      this.prisma.botInstance.update({ where: { id: input.instanceId }, data }),
      ...(input.action.kind === 'none'
        ? []
        : [
            this.prisma.instanceEvent.create({
              data: {
                instanceId: input.instanceId,
                level: 'risk',
                code: 'auto_degrade',
                message: input.action.reason,
                metaJson: JSON.stringify({
                  action: input.action.kind,
                  score: input.score,
                  reasons: input.reasons,
                }),
              },
            }),
          ]),
    ]);
  }
}
