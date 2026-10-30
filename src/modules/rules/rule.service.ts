/**
 * 约束词服务（D051）。
 *
 * 两件事：owner 增删改（带审计与归属校验）、管道读回（只读、永不 throw）。
 *
 * ## 为什么删就真删
 *
 * 素材库用软删是因为"旧对话里的引用会指到别处"（D039）。约束词没有这个问题：
 * 删掉只是"以后不再按它拦"，历史消息里也没有指向它的引用（`blockReason` 里那条
 * `rule:<id>` 只是个记录，不需要能点回去）。所以这里真删，避免表里堆一堆"已删但还在"
 * 的行让 owner 困惑。
 */

import { AppError } from '@newjob/contracts';

import { AuditAction, AuditService, type AuditActor } from '../auth/audit.service';
import { toRuleDTO, type RuleDTO } from './dto';
import { RULE_KINDS, type MatchableRule, type RuleKind } from './match';
import type { IRuleRepository, RulePatch } from './ports';

export type RuleActor = {
  userId: string;
  tenantId: string;
  role: string;
  ip?: string | null;
};

function instanceNotFound(): AppError {
  return new AppError('INSTANCE_NOT_FOUND', '实例不存在', 404);
}

function ruleNotFound(): AppError {
  return new AppError('RULE_NOT_FOUND', '约束词不存在', 404);
}

function auditActor(role: string): Extract<AuditActor, 'superadmin' | 'user'> {
  return role === 'superadmin' ? 'superadmin' : 'user';
}

export class RuleService {
  constructor(
    private readonly deps: {
      repo: IRuleRepository;
      audit: AuditService;
    },
  ) {}

  async list(actor: RuleActor, instanceId: string): Promise<RuleDTO[]> {
    if (!(await this.deps.repo.isInstanceOwned(instanceId, actor.userId))) {
      throw instanceNotFound();
    }
    const rows = await this.deps.repo.listForInstance(instanceId);
    return rows.map(toRuleDTO);
  }

  async create(
    actor: RuleActor,
    instanceId: string,
    input: { kind: string; pattern: string; note?: string | null },
  ): Promise<RuleDTO> {
    if (!(await this.deps.repo.isInstanceOwned(instanceId, actor.userId))) {
      throw instanceNotFound();
    }
    if (!(RULE_KINDS as readonly string[]).includes(input.kind)) {
      // zod 已经拦过一遍；这里是服务层的最后一道（别的地方也可能调 create）
      throw new AppError('BAD_REQUEST', `未知的规则类型：${input.kind}`, 400);
    }

    const row = await this.deps.repo.create({
      instanceId,
      kind: input.kind,
      pattern: input.pattern,
      note: input.note ?? null,
    });

    await this.record(actor, AuditAction.RuleCreate, row.id, row.instanceId, null, {
      kind: row.kind,
      pattern: row.pattern,
      note: row.note,
      enabled: row.enabled,
    });
    return toRuleDTO(row);
  }

  async update(actor: RuleActor, ruleId: string, patch: RulePatch): Promise<RuleDTO> {
    const existing = await this.deps.repo.findForUser(actor.userId, ruleId);
    if (!existing) {
      throw ruleNotFound();
    }

    const row = await this.deps.repo.update(ruleId, patch);
    await this.record(
      actor,
      AuditAction.RuleUpdate,
      row.id,
      row.instanceId,
      { pattern: existing.pattern, note: existing.note, enabled: existing.enabled },
      { pattern: row.pattern, note: row.note, enabled: row.enabled },
    );
    return toRuleDTO(row);
  }

  async remove(actor: RuleActor, ruleId: string): Promise<void> {
    const existing = await this.deps.repo.findForUser(actor.userId, ruleId);
    if (!existing) {
      throw ruleNotFound();
    }
    await this.deps.repo.delete(ruleId);
    await this.record(
      actor,
      AuditAction.RuleDelete,
      ruleId,
      existing.instanceId,
      { kind: existing.kind, pattern: existing.pattern },
      null,
    );
  }

  /**
   * 管道用：这个实例启用的全部约束词。
   *
   * **永不 throw**：规则表读不出来时按"没有规则"处理 —— 少拦一次比整条回复崩掉好。
   * 与红线不同：红线是代码里的（不可能读失败），约束词是数据（可能）。
   */
  async activeRules(instanceId: string): Promise<MatchableRule[]> {
    try {
      const rows = await this.deps.repo.listEnabled(instanceId);
      return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        pattern: row.pattern,
        enabled: row.enabled,
      }));
    } catch {
      return [];
    }
  }

  private async record(
    actor: RuleActor,
    action: AuditAction,
    target: string,
    instanceId: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
  ): Promise<void> {
    // after 里补上 instanceId：审计页只显示 target（规则 id），不知道是哪个号会很懵
    const afterPayload = { ...(after ?? {}), instanceId };
    await this.deps.audit
      .record({
        tenantId: actor.tenantId,
        actor: auditActor(actor.role),
        actorUserId: actor.userId,
        action,
        target,
        targetOwnerId: actor.userId,
        ip: actor.ip ?? null,
        ...(before ? { before } : {}),
        after: afterPayload,
      })
      .catch(() => undefined);
  }
}

export type { RuleKind };
