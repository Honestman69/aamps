/**
 * 健康分接口（M6-1 / D048）。
 *
 * 只读一条：**它在风险这一侧的现状**（分数 / 等级 / 理由 / 连续被拦次数 / 本次动作）。
 * 刻意不提供"手动降级/解除"的接口：
 *   - 降级是机器按信号做的，人手改等于把信号判断权交回给人；
 *   - 解除降级的正确做法是**问题解决后等静默期过去**，或者人工停用再启用实例。
 * 需要立刻停，用实例的 `enabled=false`（那是明确的人为动作，有审计）。
 */

import { Controller, Get, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import { AppError } from '@newjob/contracts';

import { z } from 'zod';

import { CurrentSession, SessionGuard, type AuthedRequest } from '../auth/session.guard';
import type { SessionRecord } from '../auth/session.service';
import type { RiskService } from './risk.service';
import { RISK_SERVICE } from './tokens';

/** 只校验形状，不引入别的模块的 dto（风控不该依赖人设模块） */
const instanceIdSchema = z.string().trim().min(1).max(64);
/** 事件列表的条数上限：后台一次最多看 200 条，多了没意义（要翻就缩小范围） */
const eventsQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).strict();
const parseOrThrow = (schema: z.ZodTypeAny, value: unknown): unknown => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError('BAD_REQUEST', '参数不合法', 400);
  }
  return parsed.data;
};

@Controller('api')
@UseGuards(SessionGuard)
export class RiskController {
  constructor(@Inject(RISK_SERVICE) private readonly risk: RiskService) {}

  /** 最近发生了什么（实例事件，倒序）。看板与排查都用这一条 */
  @Get('instances/:instanceId/events')
  async events(
    @Param('instanceId') instanceId: string,
    @Query() query: unknown,
    @CurrentSession() session: SessionRecord,
  ): Promise<{
    items: Array<{
      id: string;
      level: string;
      code: string;
      message: string;
      meta: unknown;
      createdAt: string;
    }>;
  }> {
    const id = parseOrThrow(instanceIdSchema, instanceId) as string;
    const { limit } = parseOrThrow(eventsQuerySchema, query) as { limit: number };
    return { items: await this.risk.listEventsFor({ userId: session.userId }, id, limit) };
  }

  @Get('instances/:instanceId/risk')
  async read(
    @Param('instanceId') instanceId: string,
    @CurrentSession() session: SessionRecord,
    @Req() _request: AuthedRequest,
  ): Promise<{
    instanceId: string;
    score: number;
    level: string;
    reasons: string[];
    consecutiveBlocks: number;
    action: { kind: string; until?: string; reason?: string };
    silentUntil: string | null;
  }> {
    const id = parseOrThrow(instanceIdSchema, instanceId) as string;
    const overview = await this.risk.inspectFor({ userId: session.userId }, id);
    return {
      instanceId: overview.instanceId,
      score: overview.score,
      level: overview.level,
      reasons: overview.reasons,
      consecutiveBlocks: overview.consecutiveBlocks,
      action: {
        kind: overview.action.kind,
        ...(overview.action.kind === 'none'
          ? {}
          : {
              ...('until' in overview.action ? { until: overview.action.until.toISOString() } : {}),
              reason: overview.action.reason,
            }),
      },
      silentUntil: overview.silentUntil ? overview.silentUntil.toISOString() : null,
    };
  }
}
