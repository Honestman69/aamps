import type { InboundMessage, OutboundAction } from '@newjob/contracts';
import { KeyLockedError } from '@newjob/contracts';
import { describe, expect, it } from 'vitest';

import type { AgentConfig } from '@/modules/config/types';
import type { MindState } from '@/modules/mind/state/mind-state';
import type { IMindStateRepository } from '@/modules/mind/state/ports';
import type { RelationshipSnapshot } from '@/modules/mind/state/relationship';
import { GatewayFailedError, GatewayService } from '@/modules/model/gateway/gateway.service';
import type { ActivePersona, InstanceOwner, IPipelineRepository } from '@/modules/pipeline/ports';
import { PipelineService, type PipelineDeps } from '@/modules/pipeline/pipeline.service';
import type { ISessionRepository, SessionRecord, StoredMessage } from '@/modules/session/persistence';
import type { ISessionWindowRepository, WindowSlice } from '@/modules/session/ports';

// ── 假实现 ──

let msgSeq = 0;
const nextId = () => `m-${++msgSeq}`;

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: nextId(),
    platform: 'qq',
    instanceId: 'inst-1',
    session: { kind: 'private', peerId: 'peer-1' },
    sender: { id: 'peer-1', name: '阿明', isOwner: false },
    segments: [{ type: 'text', text: '你好' }],
    plainText: '你好',
    isMentioned: false,
    receivedAt: new Date('2026-10-24T12:00:00'),
    ...overrides,
  };
}

class FakeSessionRepo implements ISessionRepository {
  sessions: SessionRecord[] = [];
  inboundMessages: StoredMessage[] = [];
  outboundMessages: StoredMessage[] = [];

  async ensureSession(input: {
    instanceId: string;
    kind: string;
    peerId: string;
    peerName?: string | null;
  }): Promise<SessionRecord> {
    const existing = this.sessions.find(
      (s) => s.instanceId === input.instanceId && s.kind === input.kind && s.peerId === input.peerId,
    );
    if (existing) return existing;
    const rec: SessionRecord = {
      id: `s-${this.sessions.length + 1}`,
      instanceId: input.instanceId,
      kind: input.kind,
      peerId: input.peerId,
      peerName: input.peerName ?? null,
    };
    this.sessions.push(rec);
    return rec;
  }

  async saveInbound(input: { sessionId: string; message: InboundMessage }): Promise<StoredMessage> {
    const rec: StoredMessage = {
      id: input.message.id,
      sessionId: input.sessionId,
      role: 'user',
      senderId: input.message.sender.id,
      content: input.message.plainText,
      createdAt: input.message.receivedAt,
    };
    this.inboundMessages.push(rec);
    return rec;
  }

  async saveOutbound(input: {
    sessionId: string;
    content: string;
    senderId: string | null;
    replyToMessageId?: string | null;
  }): Promise<StoredMessage> {
    const rec: StoredMessage = {
      id: nextId(),
      sessionId: input.sessionId,
      role: 'assistant',
      senderId: input.senderId,
      content: input.content,
      createdAt: new Date('2026-10-24T12:00:01'),
    };
    this.outboundMessages.push(rec);
    return rec;
  }
}

class FakeWindowRepo implements ISessionWindowRepository {
  slice: WindowSlice | null = null;
  async loadSlice(): Promise<WindowSlice | null> {
    return this.slice;
  }
}

class FakePipelineRepo implements IPipelineRepository {
  owner: InstanceOwner | null = {
    instanceId: 'inst-1',
    ownerUserId: 'user-1',
    name: '小雅',
    accountId: 'bot-1',
  };
  persona: ActivePersona | null = null;

  async findOwner(): Promise<InstanceOwner | null> {
    return this.owner;
  }
  async findActivePersona(): Promise<ActivePersona | null> {
    return this.persona;
  }
}

class FakeMindRepo implements IMindStateRepository {
  state: MindState | null = null;
  savedStates: MindState[] = [];
  relationships: RelationshipSnapshot[] = [];
  savedRelationships: Array<{ affinity: number; lastInteractionAt: Date; peerId: string }> = [];

  async loadState(): Promise<MindState | null> {
    return this.state;
  }
  async saveState(_instanceId: string, state: MindState): Promise<void> {
    this.state = state;
    this.savedStates.push(state);
  }
  async loadRelationship(_instanceId: string, peerId: string): Promise<RelationshipSnapshot | null> {
    return this.relationships.find((r) => r.peerId === peerId) ?? null;
  }
  async saveRelationship(input: {
    instanceId: string;
    peerId: string;
    nickname: string | null;
    affinity: number;
    lastInteractionAt: Date;
  }): Promise<void> {
    this.savedRelationships.push({
      peerId: input.peerId,
      affinity: input.affinity,
      lastInteractionAt: input.lastInteractionAt,
    });
    const existing = this.relationships.find((r) => r.peerId === input.peerId);
    if (existing) {
      existing.affinity = input.affinity;
      existing.lastInteractionAt = input.lastInteractionAt;
    } else {
      this.relationships.push({
        peerId: input.peerId,
        nickname: input.nickname,
        affinity: input.affinity,
        trust: 0,
        lastInteractionAt: input.lastInteractionAt,
      });
    }
  }
}

type GatewayStub = {
  chat: GatewayService['chat'];
};

function gatewayStub(outcome: { text?: string; error?: Error }): GatewayStub {
  return {
    chat: async () => {
      if (outcome.error) throw outcome.error;
      return {
        text: outcome.text ?? '你好呀',
        model: 'deepseek-chat',
        provider: 'deepseek',
        credentialId: 'cred-1',
        usage: { tokenIn: 10, tokenOut: 5 },
        costCents: 1,
        attempts: [],
      };
    },
  };
}

const PERSONA_LONG_OUTAGE: ActivePersona = {
  name: '小雅',
  tagline: null,
  identityJson: '{}',
  promptBlocksJson: '[]',
  examplesJson: '[]',
  boundariesJson: '[]',
  fallbacksJson: JSON.stringify({
    shortOutage: { private: null, group: null },
    longOutage: { private: '我这会儿有点事，晚点找你', group: null },
    budgetLimit: { private: null, group: null },
  }),
  quoteTendency: 'normal',
  behaviorJson: '{}',
};

type Harness = {
  sessions: FakeSessionRepo;
  windowRepo: FakeWindowRepo;
  pipelineRepo: FakePipelineRepo;
  mind: FakeMindRepo;
  sent: OutboundAction[];
  service: PipelineService;
  gateway: GatewayStub;
  send: (action: OutboundAction) => Promise<{ messageId: string }>;
};

function makeHarness(
  overrides: {
    gateway?: GatewayStub;
    persona?: ActivePersona | null;
    sessionFlags?: { aiPaused?: boolean; reviewMode?: boolean; muted?: boolean };
  } = {},
): Harness {
  const sessions = new FakeSessionRepo();
  const windowRepo = new FakeWindowRepo();
  const pipelineRepo = new FakePipelineRepo();
  const mind = new FakeMindRepo();
  const sent: OutboundAction[] = [];
  const gateway = overrides.gateway ?? gatewayStub({});
  pipelineRepo.persona = overrides.persona === undefined ? null : overrides.persona;

  const config = {
    get: async (): Promise<{
      config: AgentConfig;
      sessionFlags: { aiPaused: boolean; reviewMode: boolean; muted: boolean };
    }> => ({
      config: { modelMain: 'deepseek-chat' } as AgentConfig,
      sessionFlags: {
        aiPaused: overrides.sessionFlags?.aiPaused ?? false,
        reviewMode: overrides.sessionFlags?.reviewMode ?? false,
        muted: overrides.sessionFlags?.muted ?? false,
      },
    }),
  };

  const deps: PipelineDeps = {
    pipeline: pipelineRepo,
    sessions,
    windowRepo,
    mind,
    config,
    gateway: gateway as GatewayService,
    clock: () => new Date('2026-10-24T12:00:00'),
  };

  const service = new PipelineService(deps);
  const send = async (action: OutboundAction): Promise<{ messageId: string }> => {
    sent.push(action);
    return { messageId: 'out-1' };
  };

  return {
    sessions,
    windowRepo,
    pipelineRepo,
    mind,
    sent,
    service,
    gateway,
    send,
  };
}

/** 让窗口取数返回"target 就是最新一条"的最小切片 */
function latestOnlySlice(msg: InboundMessage): WindowSlice {
  return {
    target: {
      id: msg.id,
      role: 'user',
      senderId: msg.sender.id,
      senderName: msg.sender.name,
      content: msg.plainText,
      createdAt: msg.receivedAt,
    },
    before: [],
    after: [],
    afterTotals: { count: 0, distinctSenders: 0 },
  };
}

const sentText = (sent: OutboundAction[]): string[] =>
  sent
    .filter((a): a is Extract<OutboundAction, { kind: 'send' }> => a.kind === 'send')
    .map((a) => (a.segments[0]?.type === 'text' ? a.segments[0].text : ''));

// ── 测试 ──

describe('Pipeline 主链路', () => {
  it('正常对话：入站落库 → 调网关 → 出站 → 出站落库', async () => {
    const h = makeHarness();
    const msg = inbound();
    h.windowRepo.slice = latestOnlySlice(msg);

    await h.service.handle(msg, h.send);

    expect(h.sessions.inboundMessages).toHaveLength(1);
    expect(h.sessions.outboundMessages).toHaveLength(1);
    expect(h.sessions.outboundMessages[0]?.content).toBe('你好呀');
    expect(sentText(h.sent)).toEqual(['你好呀']);
  });

  it('空消息不回', async () => {
    const h = makeHarness();
    await h.service.handle(inbound({ plainText: '   ', segments: [] }), h.send);
    expect(h.sessions.inboundMessages).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });

  it('私聊回最后一条：不引用（redundant）', async () => {
    const h = makeHarness();
    const msg = inbound();
    h.windowRepo.slice = latestOnlySlice(msg);

    await h.service.handle(msg, h.send);

    const action = h.sent[0];
    expect(action?.kind).toBe('send');
    if (action?.kind === 'send') {
      expect(action.replyToMessageId).toBeUndefined();
    }
  });

  it('实例没了 → 静默（owner 查不到，不发送）', async () => {
    const h = makeHarness();
    h.pipelineRepo.owner = null;
    const msg = inbound();
    h.windowRepo.slice = latestOnlySlice(msg);

    await h.service.handle(msg, h.send);
    expect(h.sent).toHaveLength(0);
  });
});

describe('Pipeline 状态与发言决策（M3）', () => {
  it('私聊回话：花精力、亲密度上涨、状态落库', async () => {
    const h = makeHarness();
    const msg = inbound();
    h.windowRepo.slice = latestOnlySlice(msg);

    await h.service.handle(msg, h.send);

    expect(sentText(h.sent)).toEqual(['你好呀']);
    expect(h.mind.savedStates).toHaveLength(1);
    // 起始精力 0.8，回一条扣 0.02
    expect(h.mind.savedStates[0]?.energy).toBeCloseTo(0.78, 5);
    expect(h.mind.savedRelationships).toHaveLength(1);
    expect(h.mind.savedRelationships[0]?.affinity).toBeGreaterThan(0);
  });

  it('群聊没被 @、状态平常 → 只入库不回复（不花 token）', async () => {
    const h = makeHarness();
    const msg = inbound({
      session: { kind: 'group', peerId: 'group-1' },
      sender: { id: 'peer-1', name: '阿明', isOwner: false },
    });
    h.windowRepo.slice = latestOnlySlice(msg);

    await h.service.handle(msg, h.send);

    expect(sentText(h.sent)).toHaveLength(0);
    expect(h.sessions.inboundMessages).toHaveLength(1);
    // 没回话不消耗精力，但关系仍要涨一点（"看到"也算一次交互）
    expect(h.mind.savedStates[0]?.energy).toBeCloseTo(0.8, 5);
    expect(h.mind.savedRelationships[0]?.affinity).toBeGreaterThan(0);
  });

  it('群聊被 @ → 必回（不受阈值与精力影响）', async () => {
    const h = makeHarness();
    const msg = inbound({ session: { kind: 'group', peerId: 'group-1' }, isMentioned: true });
    h.windowRepo.slice = latestOnlySlice(msg);

    await h.service.handle(msg, h.send);

    expect(sentText(h.sent)).toEqual(['你好呀']);
  });

  it('会话被静默（muted）→ 只入库，不动状态', async () => {
    const h = makeHarness({ sessionFlags: { muted: true } });
    const msg = inbound();
    h.windowRepo.slice = latestOnlySlice(msg);

    await h.service.handle(msg, h.send);

    expect(h.sent).toHaveLength(0);
    expect(h.mind.savedStates).toHaveLength(0);
    expect(h.mind.savedRelationships).toHaveLength(0);
  });
});

describe('Pipeline 故障兜底（D028）', () => {
  it('余额耗尽 → 回 longOutage 话术', async () => {
    const h = makeHarness({
      gateway: gatewayStub({ error: new GatewayFailedError('balance', []) }),
      persona: PERSONA_LONG_OUTAGE,
    });

    const msg = inbound();
    h.windowRepo.slice = latestOnlySlice(msg);
    await h.service.handle(msg, h.send);

    expect(sentText(h.sent)).toEqual(['我这会儿有点事，晚点找你']);
  });

  it('未解锁 → 静默（不刷兜底）', async () => {
    const h = makeHarness({ gateway: gatewayStub({ error: new KeyLockedError() }) });
    const msg = inbound();
    h.windowRepo.slice = latestOnlySlice(msg);
    await h.service.handle(msg, h.send);
    expect(h.sent).toHaveLength(0);
  });

  it('同一条故障话术限频：多次失败只回一次', async () => {
    const h = makeHarness({
      gateway: gatewayStub({ error: new GatewayFailedError('balance', []) }),
      persona: PERSONA_LONG_OUTAGE,
    });

    for (let i = 0; i < 3; i += 1) {
      const msg = inbound();
      h.windowRepo.slice = latestOnlySlice(msg);
      await h.service.handle(msg, h.send);
    }

    // longOutage 6 小时内只回一次
    expect(sentText(h.sent)).toHaveLength(1);
  });
});
