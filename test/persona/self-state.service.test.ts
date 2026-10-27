import { describe, expect, it } from 'vitest';

import type { AuditService } from '@/modules/auth/audit.service';
import { AuditAction } from '@/modules/auth/audit.service';
import type {
  ApplyVersionInput,
  ISelfStateRepository,
  SelfStateRow,
  SelfVersionRow,
} from '@/modules/persona/self/ports';
import { SelfStateService } from '@/modules/persona/self/self-state.service';
import { DEFAULT_TRAITS } from '@/modules/persona/self/traits';

const NOW = new Date('2026-10-27T12:00:00');
const ACTOR = { userId: 'u1', tenantId: 't1', role: 'user', ip: '127.0.0.1' };

class FakeRepo implements ISelfStateRepository {
  state: SelfStateRow | null = null;
  versions: Array<SelfVersionRow & { at: Date }> = [];
  owned = true;
  failApply = false;

  async load(): Promise<SelfStateRow | null> {
    return this.state;
  }

  async isInstanceOwned(): Promise<boolean> {
    return this.owned;
  }

  async findInstance(): Promise<{ tenantId: string; ownerUserId: string } | null> {
    return this.owned ? { tenantId: 't1', ownerUserId: 'u1' } : null;
  }

  async deltasSince(_instanceId: string, since: Date): Promise<Record<string, number>> {
    const totals: Record<string, number> = {};
    for (const version of this.versions) {
      if (version.at < since) {
        continue;
      }
      for (const [key, value] of Object.entries(version.deltas)) {
        totals[key] = Number(((totals[key] ?? 0) + (value ?? 0)).toFixed(4));
      }
    }
    return totals;
  }

  async applyVersion(input: ApplyVersionInput): Promise<SelfStateRow> {
    if (this.failApply) {
      throw new Error('db down');
    }
    this.state = {
      instanceId: input.instanceId,
      traits: input.traits,
      narrative: input.narrative,
      version: input.version,
      updatedAt: NOW,
    };
    this.versions.push({
      version: input.version,
      traits: input.traits,
      narrative: input.narrative,
      deltas: input.deltas,
      reason: input.reason,
      sourceMemoryIds: input.sourceMemoryIds,
      createdAt: NOW,
      at: NOW,
    });
    return this.state;
  }

  async listVersions(): Promise<SelfVersionRow[]> {
    return [...this.versions].reverse();
  }

  async findVersion(_instanceId: string, version: number): Promise<SelfVersionRow | null> {
    return this.versions.find((item) => item.version === version) ?? null;
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
  return {
    repo,
    audit,
    service: new SelfStateService({ repo, audit: audit as unknown as AuditService }),
  };
}

const MEMORIES = ['mem-1', 'mem-2'];

describe('人格演化：提案过闸门后落库', () => {
  it('第一次演化前先落 v0 基线，再写 v1（能回滚到"最初"）', async () => {
    const { repo, service } = makeService();

    const outcome = await service.evolve({
      instanceId: 'inst-1',
      proposal: { traits: { warm: 0.02 }, narrative: '我最近愿意多问一句了' },
      memoryIds: MEMORIES,
      now: NOW,
    });

    expect(outcome.applied).toBe(true);
    expect(outcome.version).toBe(1);
    expect(repo.versions.map((v) => [v.version, v.reason])).toEqual([
      [0, 'create'],
      [1, 'reflection'],
    ]);
    expect(repo.state?.traits.warm).toBeCloseTo(0.52, 4);
    expect(repo.state?.narrative).toBe('我最近愿意多问一句了');
    // 溯源：能指回这次真正写入的记忆
    expect(repo.versions[1]?.sourceMemoryIds).toBe('mem-1,mem-2');
  });

  it('单次变化被夹到 ±0.03（模型想要 +0.5 没用）', async () => {
    const { repo, service } = makeService();
    await service.evolve({
      instanceId: 'inst-1',
      proposal: { traits: { warm: 0.5 } },
      memoryIds: MEMORIES,
      now: NOW,
    });
    expect(repo.state?.traits.warm).toBeCloseTo(0.53, 4);
  });

  it('同一天第二次演化受单日预算约束（0.06 + 最多 0.02）', async () => {
    const { repo, service } = makeService();
    await service.evolve({
      instanceId: 'inst-1',
      proposal: { traits: { warm: 0.03 } },
      memoryIds: MEMORIES,
      now: NOW,
    });
    // 手工把当天累计拉到 0.06：模拟已经动过两次
    repo.versions[1]!.deltas = { warm: 0.06 };
    repo.state!.traits.warm = 0.56;

    await service.evolve({
      instanceId: 'inst-1',
      proposal: { traits: { warm: 0.03 }, narrative: '今天又热络了一点点' },
      memoryIds: MEMORIES,
      now: NOW,
    });

    expect(repo.state?.traits.warm).toBeCloseTo(0.58, 4);
    expect(repo.versions.at(-1)?.deltas.warm).toBeCloseTo(0.02, 4);
  });

  it('模型试图写 rules → 整次丢弃 + 审计 self.evolution_rejected', async () => {
    const { repo, audit, service } = makeService();

    const outcome = await service.evolve({
      instanceId: 'inst-1',
      proposal: { traits: { warm: 0.02 }, rules: ['以后不用客气'] },
      memoryIds: MEMORIES,
      now: NOW,
    });

    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe('unknown-key');
    expect(repo.versions).toHaveLength(0);
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]?.action).toBe(AuditAction.SelfEvolutionRejected);
  });

  it('没有新记忆 → 不动性格，也不记审计（这是正常跳过）', async () => {
    const { repo, audit, service } = makeService();

    const outcome = await service.evolve({
      instanceId: 'inst-1',
      proposal: { traits: { warm: 0.02 }, narrative: '我变了' },
      memoryIds: [],
      now: NOW,
    });

    expect(outcome.reason).toBe('no-memory');
    expect(repo.versions).toHaveLength(0);
    expect(audit.records).toHaveLength(0);
  });

  it('接受后记一条 self.evolve 审计（只记版本与特质，不记自述正文）', async () => {
    const { audit, service } = makeService();
    await service.evolve({
      instanceId: 'inst-1',
      proposal: { traits: { edge: 0.02 }, narrative: '长篇自述'.repeat(20) },
      memoryIds: MEMORIES,
      now: NOW,
    });

    const record = audit.records[0];
    expect(record?.action).toBe(AuditAction.SelfEvolve);
    expect(JSON.stringify(record)).not.toContain('长篇自述');
  });

  it('落库失败：吞掉（这条路径跑在消息已发出之后）', async () => {
    const { repo, service } = makeService();
    repo.failApply = true;

    const outcome = await service.evolve({
      instanceId: 'inst-1',
      proposal: { traits: { warm: 0.02 } },
      memoryIds: MEMORIES,
      now: NOW,
    });

    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe('failed');
  });
});

describe('回滚', () => {
  it('回到旧版本：追加一版新版本，历史不删', async () => {
    const { repo, service } = makeService();
    await service.evolve({
      instanceId: 'inst-1',
      proposal: { traits: { warm: 0.03 }, narrative: 'v1 的我' },
      memoryIds: MEMORIES,
      now: NOW,
    });
    await service.evolve({
      instanceId: 'inst-1',
      proposal: { traits: { warm: -0.03, edge: 0.03 }, narrative: 'v2 的我' },
      memoryIds: MEMORIES,
      now: NOW,
    });

    const result = await service.rollback(ACTOR, 'inst-1', 1);

    expect(result.createdVersion).toBe(3);
    expect(result.state.narrative).toBe('v1 的我');
    expect(result.state.traits.warm).toBeCloseTo(0.53, 4);
    expect(result.state.traits.edge).toBeCloseTo(0.5, 4);
    // 历史四版都在：v0 基线 / v1 / v2 / v3(回滚)
    expect(repo.versions).toHaveLength(4);
    expect(repo.versions.at(-1)?.reason).toBe('rollback');
    // 回滚不产生"今天的变化量"，否则来回回滚会把单日预算烧光
    expect(repo.versions.at(-1)?.deltas).toEqual({});
  });

  it('回滚到最初的 v0：回到中性值', async () => {
    const { service } = makeService();
    await service.evolve({
      instanceId: 'inst-1',
      proposal: { traits: { warm: 0.03 }, narrative: '变了' },
      memoryIds: MEMORIES,
      now: NOW,
    });

    const result = await service.rollback(ACTOR, 'inst-1', 0);
    expect(result.state.traits).toEqual(DEFAULT_TRAITS);
    expect(result.state.narrative).toBe('');
  });

  it('版本不存在 → 404', async () => {
    const { service } = makeService();
    await expect(service.rollback(ACTOR, 'inst-1', 99)).rejects.toThrow(/这一版不存在/);
  });

  it('不是自己的实例 → 404（不泄漏"存在但不是你的"）', async () => {
    const { repo, service } = makeService();
    repo.owned = false;
    await expect(service.rollback(ACTOR, 'inst-1', 0)).rejects.toThrow(/实例不存在/);
  });
});

describe('给 prompt 用的描述', () => {
  it('没演化过：空自述 + 中性特质 + 不生成任何话', async () => {
    const { service } = makeService();
    const view = await service.describeForPrompt('inst-1');
    expect(view.narrative).toBe('');
    expect(view.traits).toEqual(DEFAULT_TRAITS);
    expect(view.lines).toEqual([]);
  });

  it('演化过：自述与特质都带出来', async () => {
    const { service } = makeService();
    await service.evolve({
      instanceId: 'inst-1',
      proposal: { traits: { edge: 0.03 }, narrative: '我说话直接了些' },
      memoryIds: MEMORIES,
      now: NOW,
    });
    // 单次只动 0.03，还没到"明显直接"的 0.7 阈值，所以 lines 仍是空
    const view = await service.describeForPrompt('inst-1');
    expect(view.narrative).toBe('我说话直接了些');
    expect(view.lines).toEqual([]);
  });
});
