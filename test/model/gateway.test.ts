/**
 * Gateway 的核心行为：选路 / 重试 / 熔断 / 记账。
 *
 * 用 stub 掉的 `fetch` 模拟厂商返回，不真的出网：
 * 这样能精确构造 429+insufficient_quota 这种"看着像限流、其实是欠费"的场景。
 */

import { KeyLockedError } from '@newjob/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { decryptWithDek, encryptWithDek, randomDek } from '@/common/crypto';
import { RuntimeKeyStore } from '@/modules/auth';
import { DEFAULT_AGENT_CONFIG, type AgentConfig } from '@/modules/config/types';
import { classifyFailure } from '@/modules/model/gateway/classify';
import { GatewayFailedError, GatewayService } from '@/modules/model/gateway/gateway.service';
import type { GatewayCandidate, IGatewayRepository, UsageRecordInput } from '@/modules/model/gateway/ports';
import { priceUsage } from '@/modules/model/metering/price';

const DEK = randomDek();
const SESSION = 'sess-1';

function candidate(overrides: Partial<GatewayCandidate> & { credentialId: string }): GatewayCandidate {
  return {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    authStyle: 'bearer',
    apiVersion: null,
    catalogJson: JSON.stringify([{ id: 'deepseek-chat', priceInPerM: 1, priceOutPerM: 2 }]),
    apiKeyEnc: encryptWithDek('sk-test-key', DEK),
    priority: 100,
    ...overrides,
  };
}

class FakeRepo implements IGatewayRepository {
  usages: UsageRecordInput[] = [];
  cooled: Array<{ credentialId: string; reason: string; until: Date }> = [];

  constructor(private candidates: GatewayCandidate[]) {}

  async listCandidates(): Promise<GatewayCandidate[]> {
    return this.candidates;
  }

  async markCooldown(credentialId: string, reason: string, until: Date): Promise<void> {
    this.cooled.push({ credentialId, reason, until });
  }

  async recordUsage(input: UsageRecordInput): Promise<void> {
    this.usages.push(input);
  }
}

function configOf(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { ...DEFAULT_AGENT_CONFIG, modelMain: 'deepseek-chat', modelCheap: 'deepseek-chat', ...overrides };
}

function makeService(options: {
  candidates: GatewayCandidate[];
  config?: Partial<AgentConfig>;
  unlocked?: boolean;
}) {
  const repo = new FakeRepo(options.candidates);
  const keyStore = new RuntimeKeyStore();
  if (options.unlocked !== false) {
    keyStore.set(SESSION, 'user-1', DEK);
  }
  const config = { get: async (): Promise<{ config: AgentConfig }> => ({ config: configOf(options.config) }) };
  const service = new GatewayService({
    repo,
    config,
    keyStore,
    clock: () => new Date('2026-10-24T00:00:00Z'),
    sleep: async () => undefined,
  });
  return { repo, service };
}

function okResponse(content = '你好', prompt = 1000, completion = 500): Response {
  return new Response(
    JSON.stringify({
      model: 'deepseek-chat',
      choices: [{ message: { content } }],
      usage: { prompt_tokens: prompt, completion_tokens: completion },
    }),
    { status: 200 },
  );
}

function errResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('错误分类', () => {
  it('429 + insufficient_quota 判为余额，不是限流', () => {
    const result = classifyFailure({ status: 429, body: '{"error":{"code":"insufficient_quota"}}' });
    expect(result.reason).toBe('balance');
    expect(result.retryable).toBe(false);
  });

  it('402 判为余额', () => {
    expect(classifyFailure({ status: 402, body: 'payment required' }).reason).toBe('balance');
  });

  it('401/403 判为鉴权，不重试', () => {
    const result = classifyFailure({ status: 401, body: 'invalid api key' });
    expect(result.reason).toBe('auth');
    expect(result.retryable).toBe(false);
  });

  it('纯 429（无余额特征）判为限流，可重试', () => {
    const result = classifyFailure({ status: 429, body: 'rate limit exceeded' });
    expect(result.reason).toBe('rate_limit');
    expect(result.retryable).toBe(true);
  });

  it('5xx 判为厂商故障，可重试；网络错误判为 network 且不冷却', () => {
    expect(classifyFailure({ status: 503, body: 'oops' })).toMatchObject({
      reason: 'provider',
      retryable: true,
    });
    expect(classifyFailure({ networkError: true })).toMatchObject({ reason: 'network', cooldownMs: 0 });
  });

  it('4xx 但不属于已知类别：归 provider 且不重试（避免死循环）', () => {
    const result = classifyFailure({ status: 400, body: 'model not found' });
    expect(result.reason).toBe('provider');
    expect(result.retryable).toBe(false);
  });
});

describe('计价', () => {
  it('按当次 Key 的目录价算，向上取整到分', () => {
    const catalog = JSON.stringify([{ id: 'm1', priceInPerM: 1, priceOutPerM: 2 }]);
    // 1000 * 1 + 500 * 2 = 2000 / 1e6 元 = 0.002 元 = 0.2 分 → 向上取整 1 分
    expect(priceUsage({ catalogJson: catalog, model: 'm1', tokenIn: 1000, tokenOut: 500 }).costCents).toBe(1);
  });

  it('目录里没有这个模型时记 0，但标记为未定价（提示要补价格）', () => {
    const result = priceUsage({ catalogJson: '[]', model: 'unknown', tokenIn: 1000, tokenOut: 500 });
    expect(result.costCents).toBe(0);
    expect(result.priced).toBe(false);
  });

  it('目录 JSON 坏了不抛异常，只是算不出钱', () => {
    expect(() => priceUsage({ catalogJson: '{bad', model: 'm', tokenIn: 1, tokenOut: 1 })).not.toThrow();
  });
});

describe('GatewayService', () => {
  it('成功调用：返回文本、写一行用量、金额按目录价', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()));
    const { repo, service } = makeService({ candidates: [candidate({ credentialId: 'c1' })] });

    const result = await service.chat({
      instanceId: 'inst-1',
      ownerUserId: 'user-1',
      sessionId: SESSION,
      purpose: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.text).toBe('你好');
    expect(result.costCents).toBe(1);
    expect(repo.usages).toHaveLength(1);
    expect(repo.usages[0]).toMatchObject({
      instanceId: 'inst-1',
      credentialId: 'c1',
      tokenIn: 1000,
      tokenOut: 500,
      costCents: 1,
      purpose: 'chat',
    });
  });

  it('余额不足：冷却该 Key 并换下一把（不删除、不禁用）', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errResponse(429, 'insufficient_quota'))
      .mockResolvedValueOnce(okResponse('备用 Key 回的话'));
    vi.stubGlobal('fetch', fetchMock);

    const { repo, service } = makeService({
      candidates: [candidate({ credentialId: 'c1', priority: 1 }), candidate({ credentialId: 'c2', priority: 2 })],
    });

    const result = await service.chat({
      instanceId: 'inst-1',
      ownerUserId: 'user-1',
      sessionId: SESSION,
      purpose: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.credentialId).toBe('c2');
    expect(result.text).toBe('备用 Key 回的话');
    expect(repo.cooled).toHaveLength(1);
    expect(repo.cooled[0]).toMatchObject({ credentialId: 'c1', reason: 'balance' });
    expect(result.attempts[0]).toMatchObject({ credentialId: 'c1', reason: 'balance' });
  });

  it('全部 Key 都鉴权失败：抛 GatewayFailedError(auth)，且每把都冷却', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => errResponse(401, 'invalid api key')));
    const { repo, service } = makeService({
      candidates: [candidate({ credentialId: 'c1' }), candidate({ credentialId: 'c2', priority: 2 })],
    });

    await expect(
      service.chat({
        instanceId: 'inst-1',
        ownerUserId: 'user-1',
        sessionId: SESSION,
        purpose: 'chat',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ name: 'GatewayFailedError', reason: 'auth' });

    expect(repo.cooled.map((item) => item.reason)).toEqual(['auth', 'auth']);
  });

  it('网络抖动会重试一次，第二次成功就不换 Key', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce(okResponse('重试成功'));
    vi.stubGlobal('fetch', fetchMock);

    const { repo, service } = makeService({ candidates: [candidate({ credentialId: 'c1' })] });

    const result = await service.chat({
      instanceId: 'inst-1',
      ownerUserId: 'user-1',
      sessionId: SESSION,
      purpose: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.text).toBe('重试成功');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(repo.usages).toHaveLength(1);
  });

  it('没有可用 Key 时抛 no_candidate（上层据此提示"去配 Key"）', async () => {
    const { service } = makeService({ candidates: [] });
    await expect(
      service.chat({
        instanceId: 'inst-1',
        ownerUserId: 'user-1',
        sessionId: SESSION,
        purpose: 'chat',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ reason: 'no_candidate' });
  });

  it('未解锁时直接抛 KeyLockedError（不尝试解密、不出网）', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { service } = makeService({ candidates: [candidate({ credentialId: 'c1' })], unlocked: false });

    await expect(
      service.chat({
        instanceId: 'inst-1',
        ownerUserId: 'user-1',
        sessionId: SESSION,
        purpose: 'chat',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toBeInstanceOf(KeyLockedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('thinking 类调用走 modelCheap（省钱），chat 走 modelMain', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { model: string };
      return okResponse(`used:${body.model}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { service } = makeService({
      candidates: [candidate({ credentialId: 'c1' })],
      config: { modelMain: 'main-model', modelCheap: 'cheap-model' },
    });

    const thought = await service.chat({
      instanceId: 'inst-1',
      ownerUserId: 'user-1',
      sessionId: SESSION,
      purpose: 'think',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(thought.text).toBe('used:cheap-model');

    const chat = await service.chat({
      instanceId: 'inst-1',
      ownerUserId: 'user-1',
      sessionId: SESSION,
      purpose: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(chat.text).toBe('used:main-model');
  });

  it('请求头里带 Bearer，且解密出来的 Key 能对上（加密链路自洽）', async () => {
    let seenAuth = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        seenAuth = (init.headers as Record<string, string>).authorization ?? '';
        return okResponse();
      }),
    );
    const { service } = makeService({ candidates: [candidate({ credentialId: 'c1' })] });

    await service.chat({
      instanceId: 'inst-1',
      ownerUserId: 'user-1',
      sessionId: SESSION,
      purpose: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(seenAuth).toBe('Bearer sk-test-key');
    expect(decryptWithDek(candidate({ credentialId: 'x' }).apiKeyEnc, DEK)).toBe('sk-test-key');
  });
});
