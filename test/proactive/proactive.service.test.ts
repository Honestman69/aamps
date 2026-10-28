import { describe, expect, it, vi } from 'vitest';

import type { ActivePersona } from '@/modules/pipeline/ports';
import type { IProactiveRepository, ProactiveCandidate } from '@/modules/proactive/ports';
import { cleanProactiveReply, ProactiveService } from '@/modules/proactive/proactive.service';
import type { SessionRecord } from '@/modules/session/persistence';

const NOW = new Date('2026-10-28T14:00:00');
const HOUR = 3600_000;

const PERSONA: ActivePersona = {
  name: '小雅',
  tagline: '22 岁，话多、心软',
  identityJson: JSON.stringify({ name: '小雅', age: 22 }),
  promptBlocksJson: '[]',
  examplesJson: '[]',
  boundariesJson: '[]',
  fallbacksJson: '{}',
  quoteTendency: 'normal',
  behaviorJson: '{}',
};

function candidate(overrides: Partial<ProactiveCandidate> = {}): ProactiveCandidate {
  return {
    peerId: 'peer-1',
    peerName: '阿明',
    affinity: 60,
    lastInteractionAt: new Date(NOW.getTime() - 50 * HOUR),
    ...overrides,
  };
}

class FakeRepo implements IProactiveRepository {
  enabled = ['inst-1'];
  candidates: ProactiveCandidate[] = [candidate()];
  lastProactive: Date | null = null;
  sentToday = 0;
  listCalls = 0;

  async listEnabledInstanceIds(): Promise<string[]> {
    return this.enabled;
  }

  async listCandidates(): Promise<ProactiveCandidate[]> {
    this.listCalls += 1;
    return this.candidates;
  }

  async lastProactiveAt(): Promise<Date | null> {
    return this.lastProactive;
  }

  async countProactiveSince(): Promise<number> {
    return this.sentToday;
  }
}

type Harness = ReturnType<typeof makeHarness>;

function makeHarness(overrides: {
  repo?: FakeRepo;
  proactiveEnabled?: boolean;
  aiPaused?: boolean;
  persona?: ActivePersona | null;
  owner?: { instanceId: string; ownerUserId: string; name: string; accountId: string } | null;
  reply?: string;
  sendOk?: boolean;
} = {}) {
  const repo = overrides.repo ?? new FakeRepo();
  const sent: Array<{ instanceId: string; action: unknown }> = [];
  const saved: Array<{ content: string; proactive?: boolean }> = [];
  const prompts: string[] = [];

  const sessions = {
    ensureSession: async (input: {
      instanceId: string;
      kind: string;
      peerId: string;
      peerName?: string | null;
    }): Promise<SessionRecord> => ({
      id: 'session-1',
      instanceId: input.instanceId,
      kind: input.kind,
      peerId: input.peerId,
      peerName: input.peerName ?? null,
    }),
    saveInbound: async (): Promise<never> => {
      throw new Error('unused');
    },
    saveOutbound: async (input: { content: string; proactive?: boolean }) => {
      saved.push({ content: input.content, proactive: input.proactive });
      return {
        id: 'msg-1',
        sessionId: 'session-1',
        role: 'assistant',
        senderId: null,
        content: input.content,
        createdAt: NOW,
      };
    },
  };

  const service = new ProactiveService({
    repo,
    config: {
      get: async () => ({
        config: { proactiveEnabled: overrides.proactiveEnabled ?? true },
        sessionFlags: { aiPaused: overrides.aiPaused ?? false, muted: false },
      }),
    },
    pipeline: {
      findOwner: async () =>
        overrides.owner === undefined
          ? { instanceId: 'inst-1', ownerUserId: 'user-1', name: '小雅', accountId: 'bot-1' }
          : overrides.owner,
      findActivePersona: async () => (overrides.persona === undefined ? PERSONA : overrides.persona),
    },
    mind: {
      loadState: async () => null,
      saveState: async () => undefined,
      loadRelationship: async () => null,
      saveRelationship: async () => undefined,
    } as never,
    memory: {
      loadForPrompt: async () => ({ facts: ['他养了一只叫豆豆的猫'], summaries: [] }),
    },
    self: {
      describeForPrompt: async () => ({ narrative: '我最近说话直接了些。', lines: [] }),
    },
    gateway: {
      chat: async (input: { messages: Array<{ role: string; content: string }> }) => {
        prompts.push(input.messages.map((m) => m.content).join('\n---\n'));
        return { text: overrides.reply ?? '"在忙什么呢"' };
      },
    },
    sessions: sessions as never,
    sender: {
      send: async (instanceId, action) => {
        if (overrides.sendOk === false) {
          return { ok: false };
        }
        sent.push({ instanceId, action });
        return { ok: true };
      },
    },
    clock: () => NOW,
  });

  return { service, repo, sent, saved, prompts };
}

describe('主动消息服务', () => {
  it('开关关着：一条候选都不查', async () => {
    const h = makeHarness({ proactiveEnabled: false });
    const report = await h.service.sweep(NOW);

    expect(h.repo.listCalls).toBe(0);
    expect(report.sent).toBe(0);
  });

  it('刚聊过：跳过，不调模型', async () => {
    const repo = new FakeRepo();
    repo.candidates = [candidate({ lastInteractionAt: new Date(NOW.getTime() - 2 * HOUR) })];
    const h = makeHarness({ repo });

    const report = await h.service.sweepInstance('inst-1', NOW);

    expect(report.sent).toBe(0);
    expect(report.skipped).toBe(1);
    expect(h.prompts).toHaveLength(0);
  });

  it('开心路径：生成 → 发送 → 落库并标 proactive', async () => {
    const h = makeHarness();
    const report = await h.service.sweepInstance('inst-1', NOW);

    expect(report.sent).toBe(1);
    expect(h.sent).toHaveLength(1);
    expect(h.saved).toEqual([{ content: '在忙什么呢', proactive: true }]);

    const action = h.sent[0]?.action as { kind: string; session: { peerId: string } };
    expect(action.kind).toBe('send');
    expect(action.session.peerId).toBe('peer-1');
  });

  it('prompt 里带上人设、记忆与"现在的你"，以及"主动开口"的约束', async () => {
    const h = makeHarness();
    await h.service.sweepInstance('inst-1', NOW);

    const prompt = h.prompts[0] ?? '';
    expect(prompt).toContain('小雅'); // 人设
    expect(prompt).toContain('豆豆'); // 记忆
    expect(prompt).toContain('我最近说话直接了些。'); // 演化
    expect(prompt).toContain('主动找他');
    // 三条禁令：别提好久没聊、别问在吗、别自我介绍
    expect(prompt).toContain('别问"在吗"');
  });

  it('会话被人工接管（aiPaused）：跳过', async () => {
    const h = makeHarness({ aiPaused: true });
    const report = await h.service.sweepInstance('inst-1', NOW);

    expect(report.sent).toBe(0);
    expect(h.sent).toHaveLength(0);
  });

  it('没有人设：跳过（没有"它自己"就不该开口）', async () => {
    const h = makeHarness({ persona: null });
    const report = await h.service.sweepInstance('inst-1', NOW);

    expect(report.sent).toBe(0);
    expect(report.events[0]?.reason).toBe('no-persona');
  });

  it('模型返回空 / 太长 / 带媒体标记：跳过，不发送', async () => {
    for (const reply of ['', '   ', '啊'.repeat(200), '看图\n[img]https://x/y.png[/img]']) {
      const h = makeHarness({ reply });
      const report = await h.service.sweepInstance('inst-1', NOW);
      expect(report.sent).toBe(0);
      expect(h.sent).toHaveLength(0);
    }
  });

  it('发送失败：不落库（没发出去就不该留下"我说过"）', async () => {
    const h = makeHarness({ sendOk: false });
    const report = await h.service.sweepInstance('inst-1', NOW);

    expect(report.sent).toBe(0);
    expect(h.saved).toHaveLength(0);
  });

  it('今天已经发满 3 条：直接不再循环（不查模型）', async () => {
    const repo = new FakeRepo();
    repo.sentToday = 3;
    const h = makeHarness({ repo });

    const report = await h.service.sweepInstance('inst-1', NOW);

    expect(report.sent).toBe(0);
    expect(h.prompts).toHaveLength(0);
  });

  it('一个实例炸了不影响其他实例', async () => {
    const repo = new FakeRepo();
    repo.enabled = ['inst-bad', 'inst-1'];
    const h = makeHarness({ repo });
    // 让第一个实例的配置读取直接抛错 → 内部 catch 后跳过（不 throw 到 sweep）
    const original = h.service['deps'].config.get;
    let calls = 0;
    h.service['deps'].config.get = async (...args: Parameters<typeof original>) => {
      calls += 1;
      if (calls === 1) {
        throw new Error('boom');
      }
      return original(...args);
    };

    const report = await h.service.sweep(NOW);
    expect(report.instances).toBe(2);
    expect(report.sent).toBe(1);
  });
});

describe('清洗模型输出', () => {
  it('去引号、去首尾空白', () => {
    expect(cleanProactiveReply('  "在忙什么呢"  ')).toBe('在忙什么呢');
    expect(cleanProactiveReply('「刚看到只猫」')).toBe('刚看到只猫');
  });

  it('空、超长、带媒体标记 → 空串（等于这次不说）', () => {
    expect(cleanProactiveReply('   ')).toBe('');
    expect(cleanProactiveReply('啊'.repeat(81))).toBe('');
    expect(cleanProactiveReply('喏 [use]猫猫[/use]')).toBe('');
  });
});
