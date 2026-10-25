import type { InboundMessage, OutboundAction } from '@newjob/contracts';
import { KeyLockedError, PLATFORM_CAPABILITIES } from '@newjob/contracts';
import { describe, expect, it } from 'vitest';

import type { AgentConfig } from '@/modules/config/types';
import type { MediaAssetService, SaveOutcome } from '@/modules/media/assets/asset.service';
import type { MediaAssetRecord } from '@/modules/media/assets/ports';
import type { IImageFetcher, InboundImage } from '@/modules/media/fetcher';
import type { TtsResult, TtsService } from '@/modules/media/tts';
import type { MindState } from '@/modules/mind/state/mind-state';
import type { IMindStateRepository } from '@/modules/mind/state/ports';
import type { RelationshipSnapshot } from '@/modules/mind/state/relationship';
import { GatewayFailedError, GatewayService } from '@/modules/model/gateway/gateway.service';
import type { ActivePersona, InstanceOwner, IPipelineRepository } from '@/modules/pipeline/ports';
import { PipelineService, type PipelineDeps } from '@/modules/pipeline/pipeline.service';
import type { ISessionRepository, SessionRecord, StoredMessage } from '@/modules/session/persistence';
import type { ISessionWindowRepository, WindowSlice } from '@/modules/session/ports';

// ── 假实现 ──

/** QQ 的能力声明：图片与语音都支持，正好用来验证媒体通道 */
const CAPS = PLATFORM_CAPABILITIES.qq;

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
  /** 出站消息携带的内心独白（D036） */
  thinkJson: Array<string | null> = [];

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
    thinkJson?: string | null;
  }): Promise<StoredMessage> {
    this.thinkJson.push(input.thinkJson ?? null);
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

class FakeImageFetcher implements IImageFetcher {
  calls: string[] = [];
  result: InboundImage | null = { dataUrl: 'data:image/png;base64,AAAA', bytes: 3 };
  /** 素材库保存走的是原始字节通道 */
  bytes: { data: Buffer; mime: string } | null = { data: Buffer.from('img'), mime: 'image/png' };

  async fetch(url: string): Promise<{ data: Buffer; mime: string } | null> {
    this.calls.push(url);
    return this.bytes;
  }

  async fetchAsDataUrl(url: string): Promise<InboundImage | null> {
    this.calls.push(url);
    return this.result;
  }
}

class FakeTts {
  calls: Array<{ text: string; voice: string; model: string }> = [];
  result: TtsResult = { kind: 'ok', filePath: '/tmp/tts/fake.mp3' };

  async synthesize(input: { text: string; voice: string; model: string }): Promise<TtsResult> {
    this.calls.push({ text: input.text, voice: input.voice, model: input.model });
    return this.result;
  }
}

class FakeAssetService {
  /** 数组顺序即 prompt 里的顺序 */
  aliases: string[] = [];
  /** 别名 → 本地文件路径 */
  files = new Map<string, string>();
  saves: Array<{ alias: string; urls: string[] }> = [];
  saveResult: SaveOutcome = {
    kind: 'saved',
    reusedFile: false,
    asset: {
      id: 'asset-1',
      instanceId: 'inst-1',
      alias: '猫猫',
      kind: 'image',
      sha256: 'a'.repeat(64),
      ext: 'png',
      mime: 'image/png',
      bytes: 3,
      tags: '',
      useCount: 0,
      lastUsedAt: null,
      createdAt: new Date('2026-10-25T00:00:00'),
    },
  };

  async listForPrompt(): Promise<Array<{ alias: string; tags: string }>> {
    return this.aliases.map((alias) => ({ alias, tags: '' }));
  }

  async resolveForSend(
    _instanceId: string,
    alias: string,
  ): Promise<{ filePath: string; asset: MediaAssetRecord } | null> {
    const filePath = this.files.get(alias);
    if (!filePath || this.saveResult.kind !== 'saved') {
      return null;
    }
    return { filePath, asset: this.saveResult.asset };
  }

  async saveFromUrls(input: { alias: string; urls: readonly string[] }): Promise<SaveOutcome> {
    this.saves.push({ alias: input.alias, urls: [...input.urls] });
    return this.saveResult;
  }
}

class FakeWindowRepo implements ISessionWindowRepository {
  slice: WindowSlice | null = null;
  /** 按 target 分片覆盖：并发/串行场景里两条消息的 target 不同 */
  byTarget = new Map<string, WindowSlice>();

  async loadSlice(input: { targetMessageId: string }): Promise<WindowSlice | null> {
    return this.byTarget.get(input.targetMessageId) ?? this.slice;
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
  /** 记录每次调用的入参：验证多模态消息、视觉模型路由与双阶段调用 */
  calls: Array<{ messages: unknown; model?: string; purpose?: string }>;
};

/** 默认的内心独白（合法的 JSON，保证 B 阶段能拿到导演指令） */
const DEFAULT_THINK = JSON.stringify({
  want_to_reply: 0.6,
  emotion_shift: 0.1,
  intent: '随便聊聊',
  key_points: ['接话'],
  tone: '轻松',
  length_hint: '短',
});

function gatewayStub(outcome: { text?: string; error?: Error; think?: string | null }): GatewayStub {
  const calls: Array<{ messages: unknown; model?: string; purpose?: string }> = [];
  return {
    calls,
    chat: async (input) => {
      calls.push({
        messages: input.messages,
        ...(input.model ? { model: input.model } : {}),
        purpose: input.purpose,
      });
      // A 阶段（think）：只返回结构化独白，不走 outcome.text
      if (input.purpose === 'think') {
        return {
          text: outcome.think === null ? 'not json' : (outcome.think ?? DEFAULT_THINK),
          model: 'deepseek-chat',
          provider: 'deepseek',
          credentialId: 'cred-1',
          usage: { tokenIn: 5, tokenOut: 5 },
          costCents: 0,
          attempts: [],
        };
      }
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
  images: FakeImageFetcher;
  tts: FakeTts;
  assets: FakeAssetService;
  sent: OutboundAction[];
  /** 表达层请求过的延迟（毫秒），按调用顺序 */
  sleeps: number[];
  service: PipelineService;
  gateway: GatewayStub;
  send: (action: OutboundAction) => Promise<{ messageId: string }>;
};

function makeHarness(
  overrides: {
    gateway?: GatewayStub;
    persona?: ActivePersona | null;
    sessionFlags?: { aiPaused?: boolean; reviewMode?: boolean; muted?: boolean };
    config?: Partial<AgentConfig>;
  } = {},
): Harness {
  const sessions = new FakeSessionRepo();
  const windowRepo = new FakeWindowRepo();
  const pipelineRepo = new FakePipelineRepo();
  const mind = new FakeMindRepo();
  const images = new FakeImageFetcher();
  const tts = new FakeTts();
  const assets = new FakeAssetService();
  const sent: OutboundAction[] = [];
  const sleeps: number[] = [];
  const gateway = overrides.gateway ?? gatewayStub({});
  pipelineRepo.persona = overrides.persona === undefined ? null : overrides.persona;

  const config = {
    get: async (): Promise<{
      config: AgentConfig;
      sessionFlags: { aiPaused: boolean; reviewMode: boolean; muted: boolean };
    }> => ({
      config: { modelMain: 'deepseek-chat', ...(overrides.config ?? {}) } as AgentConfig,
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
    images,
    tts: tts as unknown as TtsService,
    assets: assets as unknown as MediaAssetService,
    config,
    gateway: gateway as unknown as GatewayService,
    clock: () => new Date('2026-10-24T12:00:00'),
    // 表达层会等几秒再发（M3-3）。测试里不能真等，否则每条用例几秒
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
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
    images,
    tts,
    assets,
    sent,
    sleeps,
    service,
    gateway,
    send,
  };
}

/** 取 chat 阶段的第 n 次调用（双阶段后 calls[0] 是 think） */
function chatCall(target: { gateway: { calls: Array<{ messages: unknown; model?: string; purpose?: string }> } }, index = 0) {
  return target.gateway.calls.filter((call) => call.purpose === 'chat')[index];
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
    .map((a) =>
      a.segments
        .filter((segment): segment is Extract<typeof segment, { type: 'text' }> => segment.type === 'text')
        .map((segment) => segment.text)
        .join(''),
    );

// ── 测试 ──

describe('Pipeline 主链路', () => {
  it('正常对话：入站落库 → 调网关 → 出站 → 出站落库', async () => {
    const h = makeHarness();
    const msg = inbound();
    h.windowRepo.slice = latestOnlySlice(msg);

    await h.service.handle(msg, h.send, { capabilities: CAPS });

    expect(h.sessions.inboundMessages).toHaveLength(1);
    expect(h.sessions.outboundMessages).toHaveLength(1);
    expect(h.sessions.outboundMessages[0]?.content).toBe('你好呀');
    expect(sentText(h.sent)).toEqual(['你好呀']);
  });

  it('空消息不回', async () => {
    const h = makeHarness();
    await h.service.handle(inbound({ plainText: '   ', segments: [] }), h.send, { capabilities: CAPS });
    expect(h.sessions.inboundMessages).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });

  it('私聊回最后一条：不引用（redundant）', async () => {
    const h = makeHarness();
    const msg = inbound();
    h.windowRepo.slice = latestOnlySlice(msg);

    await h.service.handle(msg, h.send, { capabilities: CAPS });

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

    await h.service.handle(msg, h.send, { capabilities: CAPS });
    expect(h.sent).toHaveLength(0);
  });
});

describe('Pipeline 状态与发言决策（M3）', () => {
  it('私聊回话：花精力、亲密度上涨、状态落库', async () => {
    const h = makeHarness();
    const msg = inbound();
    h.windowRepo.slice = latestOnlySlice(msg);

    await h.service.handle(msg, h.send, { capabilities: CAPS });

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

    await h.service.handle(msg, h.send, { capabilities: CAPS });

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

    await h.service.handle(msg, h.send, { capabilities: CAPS });

    expect(sentText(h.sent)).toEqual(['你好呀']);
  });

  it('会话被静默（muted）→ 只入库，不动状态', async () => {
    const h = makeHarness({ sessionFlags: { muted: true } });
    const msg = inbound();
    h.windowRepo.slice = latestOnlySlice(msg);

    await h.service.handle(msg, h.send, { capabilities: CAPS });

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
    await h.service.handle(msg, h.send, { capabilities: CAPS });

    expect(sentText(h.sent)).toEqual(['我这会儿有点事，晚点找你']);
  });

  it('未解锁 → 静默（不刷兜底）', async () => {
    const h = makeHarness({ gateway: gatewayStub({ error: new KeyLockedError() }) });
    const msg = inbound();
    h.windowRepo.slice = latestOnlySlice(msg);
    await h.service.handle(msg, h.send, { capabilities: CAPS });
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
      await h.service.handle(msg, h.send, { capabilities: CAPS });
    }

    // longOutage 6 小时内只回一次
    expect(sentText(h.sent)).toHaveLength(1);
  });
});

describe('Pipeline 媒体（D033）', () => {
  const IMAGE_MSG = inbound({
    segments: [
      { type: 'text', text: '看这个' },
      { type: 'image', url: 'http://multimedia.nt.qq.com.cn/download?appid=1&fileid=x' },
    ],
    plainText: '看这个[图片]',
  });

  it('配了视觉模型：下载图片、发多模态内容、路由到视觉模型', async () => {
    const h = makeHarness({ config: { visionModel: 'glm-4v' } });
    h.windowRepo.slice = latestOnlySlice(IMAGE_MSG);

    await h.service.handle(IMAGE_MSG, h.send, { capabilities: CAPS });

    expect(h.images.calls).toEqual(['http://multimedia.nt.qq.com.cn/download?appid=1&fileid=x']);
    const call = chatCall(h);
    expect(call?.model).toBe('glm-4v');
    const messages = call?.messages as Array<{ role: string; content: unknown }>;
    const target = messages[messages.length - 1];
    expect(Array.isArray(target?.content)).toBe(true);
    const parts = target?.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(parts[0]).toEqual({ type: 'text', text: '看这个[图片]' });
    expect(parts[1]?.type).toBe('image_url');
    expect(parts[1]?.image_url?.url).toContain('data:image/png;base64,');
  });

  it('没配视觉模型：完全不下载图片，消息保持纯文本', async () => {
    const h = makeHarness();
    h.windowRepo.slice = latestOnlySlice(IMAGE_MSG);

    await h.service.handle(IMAGE_MSG, h.send, { capabilities: CAPS });

    expect(h.images.calls).toHaveLength(0);
    const call = chatCall(h);
    expect(call?.model).toBeUndefined();
    const messages = call?.messages as Array<{ content: unknown }>;
    expect(typeof messages[messages.length - 1]?.content).toBe('string');
  });

  it('模型用图片回复：发 image 段，正文不含标记', async () => {
    const h = makeHarness({ gateway: gatewayStub({ text: '给你看\n[img]https://example.com/cat.jpg[/img]' }) });
    const msg = inbound();
    h.windowRepo.slice = latestOnlySlice(msg);

    await h.service.handle(msg, h.send, { capabilities: CAPS });

    // M3-3 起：文字与图片分两条发（真人不会把图和话塞在同一条里）
    expect(sentText(h.sent).filter(Boolean)).toEqual(['给你看']);
    const imageAction = h.sent[1];
    expect(imageAction?.kind).toBe('send');
    if (imageAction?.kind === 'send') {
      expect(imageAction.segments).toEqual([{ type: 'image', url: 'https://example.com/cat.jpg' }]);
    }
  });

  it('内网图片链接被拦：不发图片，也不把标记漏给用户', async () => {
    const h = makeHarness({ gateway: gatewayStub({ text: '看\n[img]http://127.0.0.1/a.jpg[/img]' }) });
    const msg = inbound();
    h.windowRepo.slice = latestOnlySlice(msg);

    await h.service.handle(msg, h.send, { capabilities: CAPS });

    const action = h.sent[0];
    if (action?.kind === 'send') {
      expect(action.segments.map((s) => s.type)).toEqual(['text']);
      expect(JSON.stringify(action.segments)).not.toContain('[img]');
    }
  });

  it('模型用语音回复：文字一条 + 语音一条', async () => {
    const h = makeHarness({
      gateway: gatewayStub({ text: '好呀\n[voice]那我先睡啦[/voice]' }),
      config: { ttsCredentialId: 'cred-tts', ttsModel: 'tts-1', ttsVoice: 'nova' },
    });
    const msg = inbound();
    h.windowRepo.slice = latestOnlySlice(msg);

    await h.service.handle(msg, h.send, { capabilities: CAPS });

    expect(h.tts.calls).toEqual([{ text: '那我先睡啦', voice: 'nova', model: 'tts-1' }]);
    const kinds = h.sent.map((a) =>
      a.kind === 'send' ? a.segments.map((s) => s.type).join('+') : a.kind,
    );
    // 文本可能被拆成多条（M3-3），但语音永远是最后一条独立的
    expect(kinds.filter((kind) => kind === 'voice')).toHaveLength(1);
    expect(kinds[kinds.length - 1]).toBe('voice');
    expect(kinds[0]).toContain('text');
  });

  it('TTS 失败：语音内容降级为文字，不留空白回复', async () => {
    const h = makeHarness({
      gateway: gatewayStub({ text: '[voice]晚安[/voice]' }),
      config: { ttsCredentialId: 'cred-tts', ttsModel: 'tts-1' },
    });
    h.tts.result = { kind: 'failed', reason: 'synth' };
    const msg = inbound();
    h.windowRepo.slice = latestOnlySlice(msg);

    await h.service.handle(msg, h.send, { capabilities: CAPS });

    expect(sentText(h.sent)).toEqual(['晚安']);
  });

  it('平台不支持语音（能力声明生效）：不发语音，改说文字', async () => {
    const h = makeHarness({
      gateway: gatewayStub({ text: '[voice]晚安[/voice]' }),
      config: { ttsCredentialId: 'cred-tts', ttsModel: 'tts-1' },
    });
    const msg = inbound();
    h.windowRepo.slice = latestOnlySlice(msg);

    await h.service.handle(msg, h.send, { capabilities: PLATFORM_CAPABILITIES.douyin });

    expect(h.tts.calls).toHaveLength(0);
    expect(sentText(h.sent)).toEqual(['晚安']);
  });

  it('没配 TTS 时 prompt 不提语音，模型也就不会用', async () => {
    const h = makeHarness({ persona: { ...PERSONA_LONG_OUTAGE, fallbacksJson: '{}' } });
    const msg = inbound();
    h.windowRepo.slice = latestOnlySlice(msg);

    await h.service.handle(msg, h.send, { capabilities: CAPS });

    const messages = chatCall(h)?.messages as Array<{ role: string; content: unknown }>;
    const system = messages[0]?.content as string;
    expect(system).toContain('[img]');
    expect(system).not.toContain('[voice]');
  });
});

describe('Pipeline 素材库（D034）', () => {
  it('模型用素材：图片段指向本地文件，正文不含标记', async () => {
    const h = makeHarness({ gateway: gatewayStub({ text: '嘿嘿\n[use]猫猫震惊[/use]' }) });
    h.assets.aliases = ['猫猫震惊'];
    h.assets.files.set('猫猫震惊', '/media/assets/abc.png');
    const msg = inbound();
    h.windowRepo.slice = latestOnlySlice(msg);

    await h.service.handle(msg, h.send, { capabilities: CAPS });

    expect(sentText(h.sent).filter(Boolean)).toEqual(['嘿嘿']);
    const imageAction = h.sent[1];
    if (imageAction?.kind === 'send') {
      expect(imageAction.segments).toEqual([{ type: 'image', url: '/media/assets/abc.png' }]);
    }
  });

  it('模型编了一个不存在的名字：跳过图片，不发空消息', async () => {
    const h = makeHarness({ gateway: gatewayStub({ text: '喏\n[use]不存在的图[/use]' }) });
    const msg = inbound();
    h.windowRepo.slice = latestOnlySlice(msg);

    await h.service.handle(msg, h.send, { capabilities: CAPS });

    const action = h.sent[0];
    if (action?.kind === 'send') {
      expect(action.segments.map((s) => s.type)).toEqual(['text']);
    }
  });

  it('模型要存素材：把这条消息里的图片交给素材库', async () => {
    const h = makeHarness({ gateway: gatewayStub({ text: '存好了\n[save]猫猫震惊[/save]' }) });
    const msg = inbound({
      segments: [
        { type: 'text', text: '看这个' },
        { type: 'image', url: 'http://multimedia.nt.qq.com.cn/download?fileid=x' },
      ],
      plainText: '看这个[图片]',
    });
    h.windowRepo.slice = latestOnlySlice(msg);

    await h.service.handle(msg, h.send, { capabilities: CAPS });

    expect(h.assets.saves).toEqual([
      { alias: '猫猫震惊', urls: ['http://multimedia.nt.qq.com.cn/download?fileid=x'] },
    ]);
    // 存素材不产生额外出站，正文照发
    expect(sentText(h.sent)).toEqual(['存好了']);
  });

  it('提示词里带上素材清单，没素材时不提 [use]', async () => {
    const persona = { ...PERSONA_LONG_OUTAGE, fallbacksJson: '{}' };

    const withAssets = makeHarness({ persona });
    withAssets.assets.aliases = ['猫猫震惊', '摸头'];
    const first = inbound();
    withAssets.windowRepo.slice = latestOnlySlice(first);
    await withAssets.service.handle(first, withAssets.send, { capabilities: CAPS });
    const systemWith = (chatCall(withAssets)?.messages as Array<{ content: unknown }>)[0]
      ?.content as string;
    expect(systemWith).toContain('猫猫震惊');
    expect(systemWith).toContain('[use]');

    const withoutAssets = makeHarness({ persona });
    const second = inbound();
    withoutAssets.windowRepo.slice = latestOnlySlice(second);
    await withoutAssets.service.handle(second, withoutAssets.send, { capabilities: CAPS });
    const systemWithout = (chatCall(withoutAssets)?.messages as Array<{ content: unknown }>)[0]
      ?.content as string;
    expect(systemWithout).not.toContain('[use]');
    // 但"存下来"的能力要一直有，否则第一张图永远进不了库
    expect(systemWithout).toContain('[save]');
  });
});

describe('Pipeline 表达层（M3-3）', () => {
  const LONG_REPLY =
    '今天下班路上看到一只橘猫蹲在便利店门口，特别胖，一动不动。' +
    '它一直盯着我手里的关东煮，我就分了一小块鱼丸给它。' +
    '结果它吃完就跑了，一点情面都不给。';

  it('长回复拆成多条，每条发出前都有延迟', async () => {
    const h = makeHarness({ gateway: gatewayStub({ text: LONG_REPLY }) });
    const msg = inbound();
    h.windowRepo.slice = latestOnlySlice(msg);

    await h.service.handle(msg, h.send, { capabilities: CAPS });

    expect(h.sent.length).toBeGreaterThan(1);
    expect(h.sent.length).toBeLessThanOrEqual(3);
    // 拆出来的每条都要等一会儿再发（拟人），且总延迟有上限
    expect(h.sleeps.length).toBe(h.sent.length);
    expect(h.sleeps.every((ms) => ms > 0)).toBe(true);
    expect(h.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(12_000);
    // 内容不丢
    expect(sentText(h.sent).join('')).toBe(LONG_REPLY);
  });

  it('群里被 @：第一条先 @ 回对方', async () => {
    const h = makeHarness();
    const msg = inbound({
      session: { kind: 'group', peerId: 'group-1' },
      isMentioned: true,
    });
    h.windowRepo.slice = latestOnlySlice(msg);

    await h.service.handle(msg, h.send, { capabilities: CAPS });

    const first = h.sent[0];
    expect(first?.kind).toBe('send');
    if (first?.kind === 'send') {
      expect(first.segments[0]).toEqual({ type: 'at', userId: 'peer-1' });
    }
  });

  it('私聊不 @，也不会多出一条空消息', async () => {
    const h = makeHarness();
    const msg = inbound();
    h.windowRepo.slice = latestOnlySlice(msg);

    await h.service.handle(msg, h.send, { capabilities: CAPS });

    expect(h.sent).toHaveLength(1);
    const action = h.sent[0];
    if (action?.kind === 'send') {
      expect(action.segments.some((segment) => segment.type === 'at')).toBe(false);
    }
  });

  it('同一会话串行：后一条等前一条说完，不会交错', async () => {
    let call = 0;
    const texts = [LONG_REPLY, '第二句回复。'];
    const gateway = {
      calls: [] as Array<{ messages: unknown }>,
      chat: async (input: { purpose?: string }) => {
        // A 阶段（think）不占用 B 阶段的文本序列
        if (input.purpose === 'think') {
          return {
            text: DEFAULT_THINK,
            model: 'deepseek-chat',
            provider: 'deepseek',
            credentialId: 'cred-1',
            usage: { tokenIn: 1, tokenOut: 1 },
            costCents: 0,
            attempts: [],
          };
        }
        const text = texts[call] ?? '嗯';
        call += 1;
        return {
          text,
          model: 'deepseek-chat',
          provider: 'deepseek',
          credentialId: 'cred-1',
          usage: { tokenIn: 1, tokenOut: 1 },
          costCents: 0,
          attempts: [],
        };
      },
    };

    const h = makeHarness({ gateway });
    const first = inbound();
    const second = inbound();
    h.windowRepo.byTarget.set(first.id, latestOnlySlice(first));
    h.windowRepo.byTarget.set(second.id, latestOnlySlice(second));

    // 不 await 第一条，直接来第二条：模拟"打字期间又收到一条"
    const p1 = h.service.handle(first, h.send, { capabilities: CAPS });
    const p2 = h.service.handle(second, h.send, { capabilities: CAPS });
    await Promise.all([p1, p2]);

    const textsSent = sentText(h.sent).filter(Boolean);
    // 第一条的多段必须连着，第二条排在最后，不能穿插
    expect(textsSent[textsSent.length - 1]).toBe('第二句回复。');
    expect(textsSent.slice(0, -1).join('')).toBe(LONG_REPLY);
  });
});

describe('Pipeline 双阶段生成（M3-4 / D036）', () => {
  const THINK = JSON.stringify({
    want_to_reply: 0.8,
    emotion_shift: 0.2,
    intent: '他被工作烦到了，想吐槽',
    key_points: ['先共情', '不问细节'],
    tone: '有点心疼，别太用力',
    length_hint: '短，一两句',
  });

  it('先 think 再生成：A 阶段用 think，B 阶段带上导演指令', async () => {
    const h = makeHarness({
      gateway: gatewayStub({ text: '听着就累。', think: THINK }),
      persona: { ...PERSONA_LONG_OUTAGE, fallbacksJson: '{}', behaviorJson: '{}' },
    });
    const msg = inbound();
    h.windowRepo.slice = latestOnlySlice(msg);

    await h.service.handle(msg, h.send, { capabilities: CAPS });

    expect(h.gateway.calls.map((call) => call.purpose)).toEqual(['think', 'chat']);

    const chatMessages = chatCall(h)?.messages as Array<{ role: string; content: unknown }>;
    const system = chatMessages[0]?.content as string;
    expect(system).toContain('他被工作烦到了');
    expect(system).toContain('先共情');
    expect(system).toContain('不要说出口');
    // A 阶段的 system 是"人格 + 思考指令"，不能含导演指令
    const thinkMessages = h.gateway.calls[0]?.messages as Array<{ content: unknown }>;
    expect(thinkMessages[0]?.content as string).toContain('只输出一个 JSON');
  });

  it('情绪被推动：emotion_shift 写进 AgentState', async () => {
    const h = makeHarness({
      gateway: gatewayStub({ text: '听着就累。', think: THINK }),
      persona: { ...PERSONA_LONG_OUTAGE, fallbacksJson: '{}', behaviorJson: '{}' },
    });
    const msg = inbound();
    h.windowRepo.slice = latestOnlySlice(msg);

    await h.service.handle(msg, h.send, { capabilities: CAPS });

    expect(h.mind.savedStates.at(-1)?.mood).toBeCloseTo(0.2, 5);
  });

  it('内心独白落库，但不进对话历史', async () => {
    const h = makeHarness({
      gateway: gatewayStub({ text: '听着就累。', think: THINK }),
      persona: { ...PERSONA_LONG_OUTAGE, fallbacksJson: '{}', behaviorJson: '{}' },
    });
    const msg = inbound();
    h.windowRepo.slice = latestOnlySlice(msg);

    await h.service.handle(msg, h.send, { capabilities: CAPS });

    expect(h.sessions.thinkJson.filter(Boolean)).toHaveLength(1);
    expect(h.sessions.thinkJson.at(-1)).toContain('他被工作烦到了');
    // 落库内容是回复正文，不含独白
    expect(h.sessions.outboundMessages[0]?.content).toBe('听着就累。');
  });

  it('think 返回的不是 JSON：跳过独白，照常回复', async () => {
    const h = makeHarness({
      gateway: gatewayStub({ text: '嗯嗯。', think: null }),
      persona: { ...PERSONA_LONG_OUTAGE, fallbacksJson: '{}', behaviorJson: '{}' },
    });
    const msg = inbound();
    h.windowRepo.slice = latestOnlySlice(msg);

    await h.service.handle(msg, h.send, { capabilities: CAPS });

    expect(sentText(h.sent)).toEqual(['嗯嗯。']);
    const system = (chatCall(h)?.messages as Array<{ content: unknown }>)[0]?.content as string;
    expect(system).not.toContain('不要说出口');
    expect(h.mind.savedStates.at(-1)?.mood).toBe(0);
  });

  it('think 抛错：不影响回话（装饰层不能变单点故障）', async () => {
    let calls = 0;
    const gateway = {
      calls: [] as Array<{ messages: unknown; purpose?: string }>,
      chat: async (input: { purpose?: string; messages: unknown }) => {
        calls += 1;
        gateway.calls.push({ messages: input.messages, purpose: input.purpose });
        if (input.purpose === 'think') {
          throw new Error('boom');
        }
        return {
          text: '还在。',
          model: 'deepseek-chat',
          provider: 'deepseek',
          credentialId: 'cred-1',
          usage: { tokenIn: 1, tokenOut: 1 },
          costCents: 0,
          attempts: [],
        };
      },
    };
    const h = makeHarness({
      gateway,
      persona: { ...PERSONA_LONG_OUTAGE, fallbacksJson: '{}', behaviorJson: '{}' },
    });
    const msg = inbound();
    h.windowRepo.slice = latestOnlySlice(msg);

    await h.service.handle(msg, h.send, { capabilities: CAPS });

    expect(calls).toBe(2);
    expect(sentText(h.sent)).toEqual(['还在。']);
  });

  it('behaviorJson 关掉 think：只调一次模型', async () => {
    const h = makeHarness({
      gateway: gatewayStub({ text: '嗯。' }),
      persona: {
        ...PERSONA_LONG_OUTAGE,
        fallbacksJson: '{}',
        behaviorJson: JSON.stringify({ think: { enabled: false } }),
      },
    });
    const msg = inbound();
    h.windowRepo.slice = latestOnlySlice(msg);

    await h.service.handle(msg, h.send, { capabilities: CAPS });

    expect(h.gateway.calls.map((call) => call.purpose)).toEqual(['chat']);
    expect(sentText(h.sent)).toEqual(['嗯。']);
  });
});
