/**
 * 配置服务的缓存行为。
 *
 * 缓存是"每条消息都要读配置"的前提，所以这里测的不是性能，而是三条正确性：
 * 命中不查库、TTL 到期重查、写路径失效能立刻生效。
 */

import { describe, expect, it } from 'vitest';

import { ConfigService } from '@/modules/config/config.service';
import type { IConfigSourceRepository } from '@/modules/config/ports';
import { DEFAULT_AGENT_CONFIG, type ConfigBundle } from '@/modules/config/types';

function makeBundle(modelMain: string | null = null): ConfigBundle {
  return {
    instance: {
      credentialId: null,
      modelMain,
      modelCheap: null,
      modelFallback: null,
      modelTemperature: DEFAULT_AGENT_CONFIG.modelTemperature,
      rateLimitPerMin: DEFAULT_AGENT_CONFIG.rateLimitPerMin,
      dailyMsgCap: DEFAULT_AGENT_CONFIG.dailyMsgCap,
      nightQuiet: DEFAULT_AGENT_CONFIG.nightQuiet,
      activePersonaId: null,
      dailyBudgetCents: DEFAULT_AGENT_CONFIG.dailyBudgetCents,
      monthlyBudgetCents: DEFAULT_AGENT_CONFIG.monthlyBudgetCents,
      budgetPolicy: DEFAULT_AGENT_CONFIG.budgetPolicy,
      modelVision: null,
      ttsCredentialId: null,
      ttsModel: null,
      ttsVoice: DEFAULT_AGENT_CONFIG.ttsVoice,
      imageHosts: '',
    },
    persona: null,
    session: null,
  };
}

class FakeRepo implements IConfigSourceRepository {
  calls: Array<{ instanceId: string; sessionId?: string | null }> = [];
  constructor(private bundle: ConfigBundle | null = makeBundle()) {}

  setBundle(bundle: ConfigBundle | null): void {
    this.bundle = bundle;
  }

  async load(instanceId: string, sessionId?: string | null): Promise<ConfigBundle | null> {
    this.calls.push({ instanceId, sessionId });
    return this.bundle;
  }
}

function makeClock(start = new Date('2026-10-24T00:00:00Z')) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe('ConfigService', () => {
  it('TTL 内重复读只查一次库', async () => {
    const repo = new FakeRepo();
    const clock = makeClock();
    const service = new ConfigService({ repo, clock: clock.now, ttlMs: 1000 });

    await service.get('inst-1');
    await service.get('inst-1');
    await service.get('inst-1');

    expect(repo.calls).toHaveLength(1);
  });

  it('TTL 到期后重新查库', async () => {
    const repo = new FakeRepo();
    const clock = makeClock();
    const service = new ConfigService({ repo, clock: clock.now, ttlMs: 1000 });

    await service.get('inst-1');
    clock.advance(1001);
    await service.get('inst-1');

    expect(repo.calls).toHaveLength(2);
  });

  it('fresh=true 跳过缓存（后台"立即生效"用）', async () => {
    const repo = new FakeRepo();
    const service = new ConfigService({ repo, clock: () => new Date() });

    await service.get('inst-1');
    await service.get('inst-1', { fresh: true });

    expect(repo.calls).toHaveLength(2);
  });

  it('会话级 key 与实例级互不干扰', async () => {
    const repo = new FakeRepo();
    const service = new ConfigService({ repo, clock: () => new Date() });

    await service.get('inst-1');
    await service.get('inst-1', { sessionId: 'sess-a' });
    await service.get('inst-1', { sessionId: 'sess-b' });

    expect(repo.calls).toHaveLength(3);
    expect(service.size()).toBe(3);
  });

  it('invalidate 清掉该实例的全部会话级缓存，别的实例不受影响', async () => {
    const repo = new FakeRepo();
    const service = new ConfigService({ repo, clock: () => new Date() });

    await service.get('inst-1');
    await service.get('inst-1', { sessionId: 'sess-a' });
    await service.get('inst-2');

    expect(service.invalidate('inst-1')).toBe(2);
    expect(service.size()).toBe(1);

    // 失效后再读会重新查库
    repo.calls = [];
    await service.get('inst-1');
    expect(repo.calls).toHaveLength(1);
  });

  it('实例不存在时抛 404，而不是返回半套默认配置', async () => {
    const repo = new FakeRepo(null);
    const service = new ConfigService({ repo, clock: () => new Date() });

    await expect(service.get('ghost')).rejects.toMatchObject({
      code: 'INSTANCE_NOT_FOUND',
      httpStatus: 404,
    });
  });

  it('配置改动后 invalidate + 重新读能拿到新值', async () => {
    const repo = new FakeRepo(makeBundle('old-model'));
    const service = new ConfigService({ repo, clock: () => new Date() });

    expect((await service.get('inst-1')).config.modelMain).toBe('old-model');

    repo.setBundle(makeBundle('new-model'));
    service.invalidate('inst-1');

    expect((await service.get('inst-1')).config.modelMain).toBe('new-model');
  });
});
