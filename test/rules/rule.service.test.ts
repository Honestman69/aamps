import { describe, expect, it } from 'vitest';

import type { AuditService } from '@/modules/auth/audit.service';
import { AuditAction } from '@/modules/auth/audit.service';
import type { IRuleRepository, RuleCreateInput, RulePatch, RuleRow } from '@/modules/rules/ports';
import { RuleService } from '@/modules/rules/rule.service';

const ACTOR = { userId: 'u1', tenantId: 't1', role: 'user', ip: '127.0.0.1' };

class FakeRepo implements IRuleRepository {
  rows: RuleRow[] = [];
  owned = true;
  failList = false;
  seq = 0;

  async listForInstance(instanceId: string): Promise<RuleRow[]> {
    return this.rows.filter((row) => row.instanceId === instanceId);
  }

  async listEnabled(instanceId: string): Promise<RuleRow[]> {
    if (this.failList) {
      throw new Error('db down');
    }
    return this.rows.filter((row) => row.instanceId === instanceId && row.enabled);
  }

  async create(input: RuleCreateInput): Promise<RuleRow> {
    this.seq += 1;
    const row: RuleRow = {
      id: `rule-${this.seq}`,
      instanceId: input.instanceId,
      kind: input.kind,
      pattern: input.pattern,
      note: input.note ?? null,
      enabled: true,
      createdAt: new Date('2026-10-30T12:00:00'),
      updatedAt: new Date('2026-10-30T12:00:00'),
    };
    this.rows.push(row);
    return row;
  }

  async findForUser(): Promise<RuleRow | null> {
    return this.owned ? (this.rows[0] ?? null) : null;
  }

  async update(ruleId: string, patch: RulePatch): Promise<RuleRow> {
    const row = this.rows.find((item) => item.id === ruleId)!;
    const next = { ...row, ...patch } as RuleRow;
    this.rows = this.rows.map((item) => (item.id === ruleId ? next : item));
    return next;
  }

  async delete(ruleId: string): Promise<boolean> {
    const before = this.rows.length;
    this.rows = this.rows.filter((item) => item.id !== ruleId);
    return this.rows.length < before;
  }

  async isInstanceOwned(): Promise<boolean> {
    return this.owned;
  }
}

class FakeAudit {
  records: Array<Record<string, unknown>> = [];
  async record(input: Record<string, unknown>): Promise<unknown> {
    this.records.push(input);
    return {};
  }
}

function makeService(repo = new FakeRepo(), audit = new FakeAudit()) {
  return { repo, audit, service: new RuleService({ repo, audit: audit as unknown as AuditService }) };
}

describe('约束词服务（D051）', () => {
  it('建规则：落库 + 记审计（带 instanceId 便于排查）', async () => {
    const { repo, audit, service } = makeService();

    const created = await service.create(ACTOR, 'inst-1', { kind: 'input_block', pattern: '离婚' });

    expect(created.pattern).toBe('离婚');
    expect(created.enabled).toBe(true);
    expect(repo.rows).toHaveLength(1);
    expect(audit.records[0]?.action).toBe(AuditAction.RuleCreate);
    expect((audit.records[0]?.after as Record<string, unknown>).instanceId).toBe('inst-1');
  });

  it('未知类型 → 400（服务层最后一道）', async () => {
    const { service } = makeService();
    await expect(
      service.create(ACTOR, 'inst-1', { kind: 'regex', pattern: 'x' }),
    ).rejects.toThrow(/未知的规则类型/);
  });

  it('不是自己的实例 → 404（不能往别人身上加规则）', async () => {
    const { repo, service } = makeService();
    repo.owned = false;
    await expect(
      service.create(ACTOR, 'inst-1', { kind: 'input_block', pattern: 'x' }),
    ).rejects.toThrow(/实例不存在/);
  });

  it('改规则：审计里带改前改后', async () => {
    const { repo, audit, service } = makeService();
    await service.create(ACTOR, 'inst-1', { kind: 'input_block', pattern: '离婚' });

    await service.update(ACTOR, repo.rows[0]!.id, { enabled: false });

    const record = audit.records.find((item) => item.action === AuditAction.RuleUpdate);
    expect(record?.before).toMatchObject({ enabled: true });
    expect(record?.after).toMatchObject({ enabled: false });
  });

  it('删规则：真删 + 记审计', async () => {
    const { repo, audit, service } = makeService();
    await service.create(ACTOR, 'inst-1', { kind: 'output_block', pattern: '前女友' });
    const id = repo.rows[0]!.id;

    await service.remove(ACTOR, id);

    expect(repo.rows).toHaveLength(0);
    expect(audit.records.some((item) => item.action === AuditAction.RuleDelete)).toBe(true);
  });

  it('管道用：只返回启用的规则；读库失败按"没有规则"处理', async () => {
    const { repo, service } = makeService();
    await service.create(ACTOR, 'inst-1', { kind: 'input_block', pattern: '离婚' });
    await service.create(ACTOR, 'inst-1', { kind: 'input_block', pattern: '前女友' });
    await service.update(ACTOR, repo.rows[1]!.id, { enabled: false });

    const active = await service.activeRules('inst-1');
    expect(active).toHaveLength(1);
    expect(active[0]?.pattern).toBe('离婚');

    repo.failList = true;
    expect(await service.activeRules('inst-1')).toEqual([]);
  });
});
