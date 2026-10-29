/**
 * 风险巡检服务（M6-1 / D048）。
 *
 * 一件事：**定期把"最近发生了什么"变成分数与动作**。
 * 分数给人看，动作给机器执行（冷却 → 只收不发 → 停实例）。
 *
 * ## 为什么降级只执行、不解释
 *
 * `risk.worker` 每 5 分钟跑一次，它不做判断（判断全在 `health.ts` 的纯函数里），
 * 只负责"读信号 → 算 → 落库 → 断连接"。这样出问题时能复现：
 * 拿同样的信号列表喂纯函数，必然得到同样的结论。
 *
 * ## 为什么停实例要分开写库与断连接
 *
 * `status` / `enabled` 是**库里的结论**，由风险模块写（它算出来的）；
 * 进程内的 adapter 是**连接**，只有实例模块知道。两边各管一件事，不会互相覆盖。
 */

import { AppError } from '@newjob/contracts';

import type { DegradeAction, HealthResult } from './health';
import { assessHealth, DEGRADE_LIMITS, HEALTH_LIMITS, planDegradation } from './health';
import type { IRiskRepository } from './ports';

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export type RiskOverview = HealthResult & {
  instanceId: string;
  /** 本次巡检给出的动作（只读查询时为 `none`，不落库） */
  action: DegradeAction;
  silentUntil: Date | null;
};

export type SweepReport = {
  inspected: number;
  degraded: number;
  stopped: number;
};

const SIGNAL_LIMIT = 200;

export class RiskService {
  constructor(
    private readonly deps: {
      repo: IRiskRepository;
      /** 只做"断开当前连接"，库里的状态由本服务写 */
      connection: { drop(instanceId: string, reason: string): Promise<unknown> };
      clock?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  /** 接口层用：先校验归属，再给"它现在怎么样"；不是自己的实例一律 404 */
  async inspectFor(
    actor: { userId: string },
    instanceId: string,
    now = this.now(),
  ): Promise<RiskOverview> {
    const owned = await this.deps.repo.isInstanceOwned(instanceId, actor.userId);
    if (!owned) {
      // 不区分"不存在"和"不是你的"（同 D043 的口径）
      throw new AppError('INSTANCE_NOT_FOUND', '实例不存在', 404);
    }
    const overview = await this.inspect(instanceId, now);
    if (!overview) {
      throw new AppError('INSTANCE_NOT_FOUND', '实例不存在', 404);
    }
    return overview;
  }

  /** 事件列表（带归属校验）：后台"最近发生了什么" */
  async listEventsFor(
    actor: { userId: string },
    instanceId: string,
    limit = 50,
  ): Promise<
    Array<{ id: string; level: string; code: string; message: string; meta: unknown; createdAt: string }>
  > {
    const owned = await this.deps.repo.isInstanceOwned(instanceId, actor.userId);
    if (!owned) {
      throw new AppError('INSTANCE_NOT_FOUND', '实例不存在', 404);
    }
    const rows = await this.deps.repo.listEvents(instanceId, limit);
    return rows.map((row) => ({
      id: row.id,
      level: row.level,
      code: row.code,
      message: row.message,
      // meta 可能是坏 JSON（手工改库/历史数据）：坏了就返回空对象，别让整页 500
      meta: safeParseJson(row.metaJson),
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /** 只读：给人看的"它现在怎么样"（不落库，不改任何状态） */
  async inspect(instanceId: string, now = this.now()): Promise<RiskOverview | null> {
    const instance = await this.deps.repo.findInstance(instanceId);
    if (!instance) {
      return null;
    }
    const since = new Date(now.getTime() - HEALTH_LIMITS.windowHours * 3600_000);
    const signals = await this.deps.repo.listSignals(instanceId, since, SIGNAL_LIMIT);
    const health = assessHealth({ status: instance.status, signals, now });
    const action = planDegradation({
      consecutiveBlocks: health.consecutiveBlocks,
      now,
      currentSilentUntil: instance.silentUntil,
    });
    return {
      instanceId,
      ...health,
      action,
      silentUntil: instance.silentUntil,
    };
  }

  /** 巡检全部启用中的实例：算分 → 降级 → 必要的话断连接 */
  async sweep(now = this.now()): Promise<SweepReport> {
    const report: SweepReport = { inspected: 0, degraded: 0, stopped: 0 };
    let instances = [];
    try {
      instances = await this.deps.repo.listInstances();
    } catch {
      return report;
    }

    for (const instance of instances) {
      report.inspected += 1;
      try {
        const since = new Date(now.getTime() - HEALTH_LIMITS.windowHours * 3600_000);
        const signals = await this.deps.repo.listSignals(instance.id, since, SIGNAL_LIMIT);
        const health = assessHealth({ status: instance.status, signals, now });
        const action = planDegradation({
          consecutiveBlocks: health.consecutiveBlocks,
          now,
          currentSilentUntil: instance.silentUntil,
        });

        // 分数没变、动作也没有 → 不动库（每 5 分钟写一遍健康分没有意义）
        const actionIsNone = action.kind === 'none';
        if (actionIsNone && health.score === instance.healthScore) {
          continue;
        }

        await this.deps.repo.saveAssessment({
          instanceId: instance.id,
          score: health.score,
          action,
          reasons: health.reasons,
          now,
        });

        if (!actionIsNone) {
          report.degraded += 1;
        }
        if (action.kind === 'stop') {
          report.stopped += 1;
          // 停实例：先断连接，再让库里已经是 banned（仓储已写）
          await this.deps.connection.drop(instance.id, action.reason).catch(() => undefined);
        }
      } catch {
        // 一个实例出错不影响其他实例；巡检是后台任务，不该整体停摆
      }
    }

    return report;
  }

  /** 巡检的阈值，供测试与看板引用（只有这一处来源） */
  static get limits(): typeof HEALTH_LIMITS & typeof DEGRADE_LIMITS {
    return { ...HEALTH_LIMITS, ...DEGRADE_LIMITS };
  }
}
