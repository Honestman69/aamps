import { describe, expect, it } from 'vitest';

import { OutboundGuardService } from '@/modules/safety/outbound-guard.service';
import type { IOutboundRepository, OutboundRow } from '@/modules/safety/ports';

const NOW = new Date('2026-10-29T14:00:00');
const MIN = 60_000;

class FakeRepo implements IOutboundRepository {
  outbound: OutboundRow[] = [];
  recent: Array<{ role: string }> = [];
  instanceToday = 0;
  fail = false;

  async listOutbound(): Promise<OutboundRow[]> {
    if (this.fail) {
      throw new Error('db down');
    }
    return this.outbound;
  }

  async listRecentMessages(): Promise<Array<{ role: string }>> {
    return this.recent;
  }

  async countOutboundForInstance(): Promise<number> {
    return this.instanceToday;
  }
}

function makeGuard(repo = new FakeRepo()) {
  return { repo, guard: new OutboundGuardService({ repo }) };
}

const INPUT = { instanceId: 'inst-1', sessionId: 'session-1', text: '在忙什么呢', now: NOW };

describe('出站节流服务', () => {
  it('干净会话 → 放行', async () => {
    const { guard } = makeGuard();
    expect(await guard.check(INPUT)).toEqual({ allow: true, waitMs: 0 });
  });

  it('最近一小时已发 40 条 → 拒绝（会话小时上限）', async () => {
    const { repo, guard } = makeGuard();
    repo.outbound = Array.from({ length: 40 }, (_, i) => ({
      content: `第 ${i} 句不同的话`,
      createdAt: new Date(NOW.getTime() - i * MIN),
    }));
    expect(await guard.check(INPUT)).toMatchObject({ allow: false, reason: 'session-hour-limit' });
  });

  it('同一句话在 24h 内说过 3 次 → 拒绝（防复读机）', async () => {
    const { repo, guard } = makeGuard();
    repo.outbound = [
      { content: '在忙什么呢', createdAt: new Date(NOW.getTime() - 3 * 60 * MIN) },
      { content: '在忙什么呢？', createdAt: new Date(NOW.getTime() - 2 * 60 * MIN) },
      { content: '在忙什么呢！', createdAt: new Date(NOW.getTime() - 60 * MIN) },
    ];
    expect(await guard.check(INPUT)).toMatchObject({ allow: false, reason: 'similar-content' });
  });

  it('连续 5 条且刚说完 → 要等冷却', async () => {
    const { repo, guard } = makeGuard();
    repo.recent = [
      { role: 'assistant' },
      { role: 'assistant' },
      { role: 'assistant' },
      { role: 'assistant' },
      { role: 'assistant' },
      { role: 'user' },
    ];
    repo.outbound = [{ content: '上一句', createdAt: new Date(NOW.getTime() - 5000) }];
    const decision = await guard.check(INPUT);
    expect(decision).toEqual({ allow: true, waitMs: 25_000 });
  });

  it('实例当天到配置上限 → 拒绝', async () => {
    const { repo, guard } = makeGuard();
    repo.instanceToday = 10;
    expect(await guard.check({ ...INPUT, dailyCap: 10 })).toMatchObject({
      allow: false,
      reason: 'instance-day-limit',
    });
  });

  it('读库失败 → 放行（数不清就让它说话，别把人变成哑巴）', async () => {
    const { repo, guard } = makeGuard();
    repo.fail = true;
    expect(await guard.check(INPUT)).toEqual({ allow: true, waitMs: 0 });
  });
});
