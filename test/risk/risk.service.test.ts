import { describe, expect, it } from 'vitest';

import type { DegradeAction, RiskSignal } from '@/modules/risk/health';
import type { IRiskRepository, RiskInstanceRow } from '@/modules/risk/ports';
import { RiskService } from '@/modules/risk/risk.service';

const NOW = new Date('2026-10-29T14:00:00');
const MIN = 60_000;

function signal(code: string, minutesAgo: number, level = 'risk'): RiskSignal {
  return { code, level, createdAt: new Date(NOW.getTime() - minutesAgo * MIN) };
}

class FakeRepo implements IRiskRepository {
  instances: RiskInstanceRow[] = [];
  signals: RiskSignal[] = [];
  owned = true;
  assessments: Array<{ instanceId: string; score: number; action: DegradeAction }> = [];

  async listInstances(): Promise<RiskInstanceRow[]> {
    return this.instances;
  }

  async findInstance(instanceId: string): Promise<RiskInstanceRow | null> {
    return this.instances.find((row) => row.id === instanceId) ?? null;
  }

  async isInstanceOwned(): Promise<boolean> {
    return this.owned;
  }

  async listSignals(): Promise<RiskSignal[]> {
    return this.signals;
  }

  events: Array<{
    id: string;
    level: string;
    code: string;
    message: string;
    metaJson: string;
    createdAt: Date;
  }> = [];

  async listEvents(): Promise<typeof this.events> {
    return this.events;
  }

  async saveAssessment(input: {
    instanceId: string;
    score: number;
    action: DegradeAction;
  }): Promise<void> {
    this.assessments.push({
      instanceId: input.instanceId,
      score: input.score,
      action: input.action,
    });
  }
}

function makeService(repo = new FakeRepo()) {
  const dropped: string[] = [];
  const service = new RiskService({
    repo,
    connection: {
      drop: async (instanceId: string) => {
        dropped.push(instanceId);
        return true;
      },
    },
    clock: () => NOW,
  });
  return { repo, service, dropped };
}

function instance(overrides: Partial<RiskInstanceRow> = {}): RiskInstanceRow {
  return { id: 'inst-1', status: 'online', silentUntil: null, healthScore: 100, ...overrides };
}

describe('风控巡检（RiskService.sweep）', () => {
  it('一切正常且分数没变 → 不写库（每 5 分钟写一遍健康分没有意义）', async () => {
    const { repo, service } = makeService();
    repo.instances = [instance()];

    const report = await service.sweep(NOW);

    expect(report).toEqual({ inspected: 1, degraded: 0, stopped: 0 });
    expect(repo.assessments).toHaveLength(0);
  });

  it('被拦一次 → 写分 75 + 冷却，不断连接', async () => {
    const { repo, service, dropped } = makeService();
    repo.instances = [instance()];
    repo.signals = [signal('send_blocked', 5)];

    const report = await service.sweep(NOW);

    expect(report.degraded).toBe(1);
    expect(repo.assessments[0]?.score).toBe(75);
    expect(repo.assessments[0]?.action.kind).toBe('cooldown');
    expect(dropped).toHaveLength(0);
  });

  it('连续被拦两次 → 只收不发（readonly），仍不断连接', async () => {
    const { repo, service, dropped } = makeService();
    repo.instances = [instance()];
    repo.signals = [signal('send_blocked', 5), signal('send_blocked', 15)];

    await service.sweep(NOW);

    expect(repo.assessments[0]?.action.kind).toBe('readonly');
    expect(dropped).toHaveLength(0);
  });

  it('连续被拦三次 → 停实例：写库 + 断开连接', async () => {
    const { repo, service, dropped } = makeService();
    repo.instances = [instance()];
    repo.signals = [
      signal('send_blocked', 5),
      signal('send_blocked', 15),
      signal('send_blocked', 25),
    ];

    const report = await service.sweep(NOW);

    expect(report.stopped).toBe(1);
    expect(repo.assessments[0]?.action.kind).toBe('stop');
    expect(dropped).toEqual(['inst-1']);
  });

  it('分数变了但没有降级动作也会写（看板要看到趋势）', async () => {
    const { repo, service } = makeService();
    repo.instances = [instance({ healthScore: 100 })];
    repo.signals = [signal('offline', 30, 'warn')];

    await service.sweep(NOW);

    expect(repo.assessments[0]?.score).toBe(90);
    expect(repo.assessments[0]?.action.kind).toBe('none');
  });

  it('一个实例出错不影响其他实例', async () => {
    const { repo, service } = makeService();
    repo.instances = [instance({ id: 'bad' }), instance({ id: 'inst-2' })];
    const original = repo.listSignals.bind(repo);
    let calls = 0;
    repo.listSignals = async (...args: Parameters<typeof original>) => {
      calls += 1;
      if (calls === 1) {
        throw new Error('db boom');
      }
      return original(...args);
    };

    const report = await service.sweep(NOW);

    expect(report.inspected).toBe(2);
    // 第一个炸了，第二个仍然被检查（只是分数没变所以没写库）
    expect(calls).toBe(2);
  });
});

describe('只读查询（inspect / inspectFor）', () => {
  it('不落库、不改状态，只返回分数与本次动作', async () => {
    const { repo, service } = makeService();
    repo.instances = [instance()];
    repo.signals = [signal('send_blocked', 5)];

    const overview = await service.inspect('inst-1', NOW);

    expect(overview?.score).toBe(75);
    expect(overview?.action.kind).toBe('cooldown');
    expect(repo.assessments).toHaveLength(0);
  });

  it('实例不存在 → null', async () => {
    const { service } = makeService();
    expect(await service.inspect('nope', NOW)).toBeNull();
  });

  it('不是自己的实例 → 404（不区分"不存在"和"不是你的"）', async () => {
    const { repo, service } = makeService();
    repo.owned = false;
    await expect(service.inspectFor({ userId: 'u1' }, 'inst-1', NOW)).rejects.toThrow(/实例不存在/);
  });
});

describe('事件列表（M6-3）', () => {
  it('返回倒序事件并把 meta 解析成对象', async () => {
    const { repo, service } = makeService();
    repo.events = [
      {
        id: 'e1',
        level: 'risk',
        code: 'send_blocked',
        message: '发送被平台拦截',
        metaJson: JSON.stringify({ code: 1200 }),
        createdAt: NOW,
      },
    ];

    const items = await service.listEventsFor({ userId: 'u1' }, 'inst-1', 50);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ code: 'send_blocked', meta: { code: 1200 } });
    expect(items[0]?.createdAt).toBe(NOW.toISOString());
  });

  it('meta 是坏 JSON → 空对象（坏数据不该让整页 500）', async () => {
    const { repo, service } = makeService();
    repo.events = [
      {
        id: 'e2',
        level: 'warn',
        code: 'offline',
        message: '掉线',
        metaJson: '{oops',
        createdAt: NOW,
      },
    ];

    const items = await service.listEventsFor({ userId: 'u1' }, 'inst-1');
    expect(items[0]?.meta).toEqual({});
  });

  it('不是自己的实例 → 404', async () => {
    const { repo, service } = makeService();
    repo.owned = false;
    await expect(service.listEventsFor({ userId: 'u1' }, 'inst-1')).rejects.toThrow(/实例不存在/);
  });
});
