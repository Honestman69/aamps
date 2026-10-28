/**
 * 人格演化服务（M5-2 / D020 第三层）。
 *
 * 职责只有两件：**把提案过闸门后落库**、**回滚到某一版**。
 * 决策逻辑全在 `evolution.ts`（纯函数），这里是事务、归属与审计。
 *
 * ## 三条纪律
 *
 * 1. **归属先校验**：任何按 `instanceId` 的写操作，先问"这个实例是不是你的"。
 *    没有这一步，拿到别人的实例 id 就能改别人的性格。
 * 2. **历史只增不改**：回滚不是删掉坏版本，而是追加一版"恢复到 vN 的内容"。
 *    删了历史就再也说不清"它中间为什么会那样说话"。
 * 3. **拒绝要留痕**：模型试图写 `rules` / `redLines` 这类键，整次丢弃 + 记
 *    `self.evolution_rejected`。不记的话，"它有没有试探过红线"永远没人知道。
 */

import { AppError } from '@newjob/contracts';

import { AuditAction, AuditService, type AuditActor } from '../../auth/audit.service';
import {
  DEFAULT_TRAITS,
  describeTraits,
  EVOLUTION_LIMITS,
  parseProposal,
  parseTraits,
  planEvolution,
  TRAITS,
  type EvolutionRejectReason,
  type TraitKey,
  type Traits,
} from './evolution';
import type { ISelfStateRepository, SelfStateRow, SelfVersionRow } from './ports';

export type SelfActor = {
  userId: string;
  tenantId: string;
  role: string;
  ip?: string | null;
};

export type SelfStateView = {
  instanceId: string;
  traits: Traits;
  narrative: string;
  version: number;
  updatedAt: string | null;
  /** 有没有真的演化过（没演化过时 traits 是中性值，narrative 为空） */
  evolved: boolean;
};

export type SelfVersionView = {
  version: number;
  traits: Traits;
  narrative: string;
  deltas: Partial<Record<TraitKey, number>>;
  reason: string;
  sourceMemoryIds: string[];
  createdAt: string;
};

export type EvolveOutcome = {
  applied: boolean;
  reason: 'applied' | EvolutionRejectReason | 'failed';
  detail?: string;
  version?: number;
};

function instanceNotFound(): AppError {
  return new AppError('INSTANCE_NOT_FOUND', '实例不存在', 404);
}

function versionNotFound(): AppError {
  return new AppError('SELF_VERSION_NOT_FOUND', '这一版不存在', 404);
}

function auditActor(role: string): Extract<AuditActor, 'superadmin' | 'user'> {
  return role === 'superadmin' ? 'superadmin' : 'user';
}

/** 当天零点（本地时区）：单日预算按"人过的这一天"算，不按 UTC */
function startOfDay(now: Date): Date {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day;
}

export class SelfStateService {
  constructor(
    private readonly deps: {
      repo: ISelfStateRepository;
      audit: AuditService;
    },
  ) {}

  /**
   * 读当前状态。没演化过就返回中性值（**不写库**）——
   * "还没变成什么样"和"已经变成中性值"是两件事，前者不该在历史里留下一条空记录。
   */
  async load(instanceId: string): Promise<SelfStateView> {
    const row = await this.deps.repo.load(instanceId);
    return row ? this.toView(row, true) : this.toView(null, false);
  }

  async listVersions(actor: SelfActor, instanceId: string, limit = 50): Promise<SelfVersionView[]> {
    await this.assertOwned(actor.userId, instanceId);
    const rows = await this.deps.repo.listVersions(instanceId, limit);
    return rows.map((row) => this.toVersionView(row));
  }

  /**
   * 反思产出的演化提案 → 过闸门 → 落库。
   *
   * **永不 throw**：它由 `write-memory` pipe 在"消息已发出"之后调用，
   * 抛出去会让对方多收一条兜底话术（见 D045）。闸门拒绝是正常分支，不是异常。
   */
  async evolve(input: {
    instanceId: string;
    proposal: unknown;
    memoryIds: readonly string[];
    now: Date;
  }): Promise<EvolveOutcome> {
    try {
      const parsed = parseProposal(input.proposal);
      if (!parsed.ok) {
        await this.recordRejected(input.instanceId, parsed.reason, parsed.detail);
        return { applied: false, reason: parsed.reason, detail: parsed.detail };
      }

      // 先读当前状态（**不落基线**）：被闸门拒绝的提案不该在历史里留下任何痕迹
      const existing = await this.deps.repo.load(input.instanceId);
      const currentTraits = existing?.traits ?? { ...DEFAULT_TRAITS };
      const currentNarrative = existing?.narrative ?? '';
      const currentVersion = existing?.version ?? 0;

      const todayTotals = await this.deps.repo.deltasSince(
        input.instanceId,
        startOfDay(input.now),
      );

      const plan = planEvolution({
        current: { traits: currentTraits, narrative: currentNarrative },
        proposal: parsed.proposal,
        todayTotals,
        memoryIds: input.memoryIds,
      });

      if (!plan.ok) {
        // 只有"结构上不对"才记审计：no-change / no-memory 是正常跳过，记了只是噪声
        if (plan.reason === 'bad-narrative' || plan.reason === 'unknown-key' || plan.reason === 'invalid-delta') {
          await this.recordRejected(input.instanceId, plan.reason, plan.detail);
        }
        return { applied: false, reason: plan.reason, detail: plan.detail };
      }

      // 第一次演化前补一版 v0 基线：这样"回滚到最初"也是一个真实存在的版本
      if (!existing) {
        await this.deps.repo.applyVersion({
          instanceId: input.instanceId,
          version: 0,
          traits: { ...DEFAULT_TRAITS },
          narrative: '',
          deltas: {},
          reason: 'create',
          sourceMemoryIds: null,
        });
      }

      const version = currentVersion + 1;
      const saved = await this.deps.repo.applyVersion({
        instanceId: input.instanceId,
        version,
        traits: plan.traits,
        narrative: plan.narrative,
        deltas: plan.deltas,
        reason: 'reflection',
        sourceMemoryIds: input.memoryIds.join(','),
      });

      await this.auditEvolve(
        input.instanceId,
        { instanceId: input.instanceId, traits: currentTraits, narrative: currentNarrative, version: currentVersion, updatedAt: input.now },
        saved,
        'system',
        null,
        plan.deltas,
      );
      return { applied: true, reason: 'applied', version: saved.version };
    } catch {
      // 见方法注释：这条路径上的任何异常都不能冒到管道里
      return { applied: false, reason: 'failed', detail: '演化过程出错，已跳过' };
    }
  }

  /** 回滚：把某一版的内容再写一次（版本 +1，历史不删） */
  async rollback(
    actor: SelfActor,
    instanceId: string,
    version: number,
    now = new Date(),
  ): Promise<{ state: SelfStateView; createdVersion: number }> {
    await this.assertOwned(actor.userId, instanceId);

    const target = await this.deps.repo.findVersion(instanceId, version);
    if (!target) {
      throw versionNotFound();
    }

    const current = await this.loadOrBaseline(instanceId, now);
    const saved = await this.deps.repo.applyVersion({
      instanceId,
      version: current.version + 1,
      traits: target.traits,
      narrative: target.narrative,
      // 回滚不产生"今天的变化量"：否则同一天来回回滚会把单日预算烧光
      deltas: {},
      reason: 'rollback',
      sourceMemoryIds: null,
    });

    await this.auditEvolve(instanceId, current, saved, auditActor(actor.role), actor, {});
    return { state: this.toView(saved, true), createdVersion: saved.version };
  }

  /** prompt 用：自述 + 由特质推出来的几句话 */
  async describeForPrompt(
    instanceId: string,
  ): Promise<{ narrative: string; traits: Traits; lines: string[] }> {
    try {
      const row = await this.deps.repo.load(instanceId);
      const traits = row ? row.traits : { ...DEFAULT_TRAITS };
      return {
        narrative: row?.narrative ?? '',
        traits,
        lines: describeTraits(traits),
      };
    } catch {
      // 演化层读不出来 = 这次没有"现在的你"，人格种子照常生效
      return { narrative: '', traits: { ...DEFAULT_TRAITS }, lines: [] };
    }
  }

  // ── 内部 ──

  private async loadOrBaseline(instanceId: string, now: Date): Promise<SelfStateRow> {
    const existing = await this.deps.repo.load(instanceId);
    if (existing) {
      return existing;
    }
    // 第一次演化前先落一版 v0 基线：这样"回滚到最初"也是一个真实存在的版本
    const baseline = await this.deps.repo.applyVersion({
      instanceId,
      version: 0,
      traits: { ...DEFAULT_TRAITS },
      narrative: '',
      deltas: {},
      reason: 'create',
      sourceMemoryIds: null,
    });
    void now;
    return baseline;
  }

  private async assertOwned(userId: string, instanceId: string): Promise<void> {
    const owned = await this.deps.repo.isInstanceOwned(instanceId, userId);
    if (!owned) {
      // 不区分"不存在"和"不是你的"
      throw instanceNotFound();
    }
  }

  private async recordRejected(
    instanceId: string,
    reason: string,
    detail: string,
  ): Promise<void> {
    try {
      const instance = await this.deps.repo.findInstance(instanceId);
      if (!instance) {
        return;
      }
      await this.deps.audit.record({
        tenantId: instance.tenantId,
        actor: 'system',
        actorUserId: instance.ownerUserId,
        action: AuditAction.SelfEvolutionRejected,
        target: instanceId,
        targetOwnerId: instance.ownerUserId,
        ip: null,
        // 只记原因与短的拒绝说明，**不记模型原始输出**：它可能很长，也可能包含不该扩散的内容
        after: { reason, detail: detail.slice(0, 200) },
      });
    } catch {
      // 审计失败不能反过来影响演化流程
    }
  }

  private async auditEvolve(
    instanceId: string,
    before: SelfStateRow,
    after: SelfStateRow,
    actor: Extract<AuditActor, 'superadmin' | 'user' | 'system'>,
    as: SelfActor | null,
    deltas: Partial<Record<TraitKey, number>>,
  ): Promise<void> {
    try {
      const instance = await this.deps.repo.findInstance(instanceId);
      if (!instance) {
        return;
      }
      await this.deps.audit.record({
        tenantId: as?.tenantId ?? instance.tenantId,
        actor,
        actorUserId: as?.userId ?? instance.ownerUserId,
        action: as ? AuditAction.SelfRollback : AuditAction.SelfEvolve,
        target: instanceId,
        targetOwnerId: instance.ownerUserId,
        ip: as?.ip ?? null,
        // 自述可能很长，审计只留版本号与特质；正文要看就看版本表
        before: { version: before.version, traits: before.traits },
        after: { version: after.version, traits: after.traits, deltas },
      });
    } catch {
      // 同上
    }
  }

  private toView(row: SelfStateRow | null, evolved: boolean): SelfStateView {
    return {
      instanceId: row?.instanceId ?? '',
      traits: row ? parseTraits(JSON.stringify(row.traits)) : { ...DEFAULT_TRAITS },
      narrative: row?.narrative ?? '',
      version: row?.version ?? 0,
      updatedAt: row ? row.updatedAt.toISOString() : null,
      evolved,
    };
  }

  private toVersionView(row: SelfVersionRow): SelfVersionView {
    return {
      version: row.version,
      traits: row.traits,
      narrative: row.narrative,
      deltas: row.deltas,
      reason: row.reason,
      sourceMemoryIds: row.sourceMemoryIds ? row.sourceMemoryIds.split(',').filter(Boolean) : [],
      createdAt: row.createdAt.toISOString(),
    };
  }
}

/** 供测试与文档引用：闸门数字只有这一处来源 */
export { EVOLUTION_LIMITS, TRAITS };
