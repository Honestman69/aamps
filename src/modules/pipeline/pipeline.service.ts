/**
 * Pipeline：消息主链路。
 *
 * M2 打通了最小闭环，M3 在它上面**加 Pipe**，不推倒重来：
 *
 * ```
 * InboundMessage
 *   → 落库（upsert session + 存入站消息）
 *   → 取 owner + 人设 + 配置
 *   → 治理（人工接管 / 会话静默 → 只入库不说话）
 *   → 心智状态衰减（mood / energy）+ 关系读取
 *   → buildWindow（D031：target 必须在窗口里）
 *   → attention（M3：要不要回）—— 不回就到此为止，不花 token
 *   → assemblePrompt（D020：种子 → 情境 → 语气）
 *   → ModelGateway.chat（D024 预算 / D025 熔断 / 记账）
 *   → decideQuote（D030）
 *   → 出站 + 落库
 *   → 状态与关系回写（花精力、长亲密度）
 * ```
 *
 * 失败时（`GatewayFailedError`）走兜底：按 D028 用 `faultToSlot` 映射到话术槽位，
 * 再按 `decideSpeak` 限频，`resolveFallback` 取文本，可能静默。
 *
 * ## attention 放的位置就是它省钱的地方
 *
 * 判定在**调模型之前**。自用场景里大部分群消息不该回，提前判掉既省 token，
 * 也避免"有问必答"那种客服感（ARCHITECTURE 5）。
 *
 * ## 状态层失败不阻断对话
 *
 * `mind` 仓储的读写都吞异常：状态是"表现层"的东西，坏了最多这几句不像人，
 * 而对话本身必须继续。反过来（因为读状态失败就不回消息）会把一个装饰层变成单点故障（D011）。
 *
 * ## 还没做的（M3 后续）
 *
 * - think（内心独白 → emotion_shift 推动 mood）
 * - moderate（输出审核）
 * - express（拆条 / 打字延迟 / 表情 / 夜间静默 / 连发上限）
 */

import type {
  InboundMessage,
  OutboundAction,
  PlatformCapabilities,
  Segment,
} from '@newjob/contracts';
import { KeyLockedError } from '@newjob/contracts';

import type { ResolvedConfig } from '../config/types';
import type { MediaAssetService } from '../media/assets/asset.service';
import type { IImageFetcher } from '../media/fetcher';
import { parseMediaIntent, stripStrayMediaTags } from '../media/intent';
import type { TtsService } from '../media/tts';
import { decideAttention } from '../mind/attention/attention';
import { parseAttentionPolicy } from '../mind/attention/policy';
import { planTextReply, parseExpressionPolicy } from '../mind/expression/plan';
import { messageSeed, seededRand } from '../mind/expression/rand';
import { computeSignals } from '../mind/attention/signals';
import {
  applyReply,
  createMindState,
  decayState,
  isBusy,
  type MindState,
} from '../mind/state/mind-state';
import type { IMindStateRepository } from '../mind/state/ports';
import { nextAffinity, type RelationshipSnapshot } from '../mind/state/relationship';
import { GatewayFailedError, GatewayService } from '../model/gateway/gateway.service';
import type { ChatMessage, ContentPart } from '../model/providers/openai-compatible';
import { parseFallbacks, resolveFallback } from '../persona/fallbacks';
import { decideSpeak, faultToSlot, type SpeakFailureReason } from '../persona/fault-slot';
import { assemblePrompt } from '../persona/prompt';
import { decideQuote, parseQuoteTendency } from '../persona/quote';
import {
  buildWindow,
  DEFAULT_WINDOW_LIMITS,
  flattenWindow,
  windowQuoteFacts,
} from '../session/window';
import type { ISessionRepository } from '../session/persistence';
import type { ISessionWindowRepository } from '../session/ports';
import type { IPipelineRepository } from './ports';

/** Pipeline 依赖。全部走接口注入，测试里换假实现 */
export type PipelineDeps = {
  pipeline: IPipelineRepository;
  sessions: ISessionRepository;
  windowRepo: ISessionWindowRepository;
  /** 心智状态（M3）：mood / energy / affinity */
  mind: IMindStateRepository;
  /** 入站图片 → data URL（D033）；失败只丢这一张图 */
  images: IImageFetcher;
  /** 语音合成（D033）；失败降级为文字 */
  tts: TtsService;
  /** 素材库（D034）：存表情/图片，按别名取用 */
  assets: MediaAssetService;
  config: {
    get(
      instanceId: string,
      options?: { sessionId?: string | null },
    ): Promise<Pick<ResolvedConfig, 'config' | 'sessionFlags'>>;
  };
  gateway: GatewayService;
  clock?: () => Date;
  /**
   * 延迟执行器（M3-3）。默认 `setTimeout`；测试里注入空实现，否则每条用例都要真等几秒。
   * 称之为"注入点"而不是"可选项"：延迟是这个模块的正常行为，不是错误分支。
   */
  sleep?: (ms: number) => Promise<void>;
};

/** 出站回调：生产里是当前实例 adapter 的 send，测试里是收集器 */
export type SendAction = (action: OutboundAction) => Promise<{ messageId: string }>;

export class PipelineService {
  /** scope（instanceId:sessionId）→ slot → 发言时间点。纯限频状态，丢了只多几句 */
  private readonly fallbackLog = new Map<string, Map<string, Date[]>>();

  /**
   * 每个会话的串行队列。
   *
   * 为什么需要：表达层会"等几秒再发"（拟人）。没有串行，两条相隔 1 秒的消息会
   * 各自等各自的，最后交错发出去——比秒回还不像人。串行之后，同一个人的第二条消息
   * 会等它把第一条说完，这正是真人的行为。
   *
   * 队列按 `instanceId + 会话` 分片，不阻塞别的会话；进程内 Map，丢了只影响"同时来两条"。
   */
  private readonly sessionQueue = new Map<string, Promise<void>>();

  constructor(private readonly deps: PipelineDeps) {}

  private async wait(ms: number): Promise<void> {
    if (ms <= 0) {
      return;
    }
    if (this.deps.sleep) {
      await this.deps.sleep(ms);
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private now(): Date {
    return this.deps.clock?.() ?? new Date();
  }

  /**
   * 处理一条入站消息。永不 throw —— 任何失败都转成"回兜底话术或静默"。
   *
   * @param send 出站回调。之所以作为参数而不是依赖注入：send 绑定到"当前这条连接
   *             的 adapter"，每个实例的 adapter 不同，不能全局注入一个。
   */
  async handle(
    message: InboundMessage,
    send: SendAction,
    options: { capabilities: PlatformCapabilities },
  ): Promise<void> {
    // 纯图片消息的 plainText 是「[图片]」，非空；真正该丢的是空消息
    if (!message.plainText.trim() && message.segments.length === 0) {
      return;
    }

    const key = `${message.instanceId}:${message.session.kind}:${message.session.peerId}`;
    const previous = this.sessionQueue.get(key) ?? Promise.resolve();
    const current = previous.then(
      () => this.runOnce(message, send, options.capabilities),
      () => this.runOnce(message, send, options.capabilities),
    );
    this.sessionQueue.set(key, current);
    try {
      await current;
    } finally {
      // 只清理自己这一条：否则会把后来者的队列项删掉，串行就断了
      if (this.sessionQueue.get(key) === current) {
        this.sessionQueue.delete(key);
      }
    }
  }

  /** 处理一条消息并吞掉所有异常（永不 throw），串行队列里跑的就是它 */
  private async runOnce(
    message: InboundMessage,
    send: SendAction,
    capabilities: PlatformCapabilities,
  ): Promise<void> {
    try {
      await this.process(message, send, capabilities);
    } catch (err) {
      await this.handleFailure(message, send, err instanceof Error ? err : new Error(String(err)));
    }
  }

  private async process(
    message: InboundMessage,
    send: SendAction,
    caps: PlatformCapabilities,
  ): Promise<void> {
    const instanceId = message.instanceId;
    const channel: 'private' | 'group' = message.session.kind === 'group' ? 'group' : 'private';

    // ① 落库：会话 + 入站消息
    const session = await this.deps.sessions.ensureSession({
      instanceId,
      kind: message.session.kind,
      peerId: message.session.peerId,
      peerName: message.sender.name,
    });
    const inbound = await this.deps.sessions.saveInbound({ sessionId: session.id, message });

    // ② 取 owner + 人设 + 配置（配置要提前：会话开关决定"要不要理"）
    const owner = await this.deps.pipeline.findOwner(instanceId);
    if (!owner) {
      return; // 实例没了，无处可发
    }
    const [persona, resolved] = await Promise.all([
      this.deps.pipeline.findActivePersona(instanceId),
      this.deps.config.get(instanceId, { sessionId: session.id }),
    ]);

    const config = resolved.config;

    // ③ 治理：人工接管 / 会话静默 → 只入库，不说话，也不动状态
    //    人接管期间的对话不属于"它"的经历，记进亲密度会让关系变成人工客服的关系
    if (resolved.sessionFlags.aiPaused || resolved.sessionFlags.muted) {
      return;
    }

    const now = this.now();

    // ④ 心智状态先衰减到"现在"，再拿它做判断（否则会拿几小时前的精力做决策）
    const state = await this.loadMindState(instanceId, now);
    const relationship = await this.loadRelationship(instanceId, message.sender.id);

    // ⑤ 取窗口
    const limits = DEFAULT_WINDOW_LIMITS[channel];
    const slice = await this.deps.windowRepo.loadSlice({
      sessionId: session.id,
      targetMessageId: inbound.id,
      beforeLimit: limits.maxMessages * 2,
      afterLimit: limits.maxMessages * 2,
    });
    if (!slice) {
      return;
    }
    const window = buildWindow({
      targetId: inbound.id,
      messages: [...slice.before, slice.target, ...slice.after],
      limits,
      now,
    });
    if (!window) {
      return;
    }

    // ⑥ 发言人决策（M3）：判定在调模型之前，判掉就不花 token
    const signals = computeSignals(window, now);
    const expression = parseExpressionPolicy(persona?.behaviorJson ?? null);
    const attention = decideAttention(
      {
        channel,
        isMentioned: message.isMentioned,
        state: { energy: state.energy, busy: isBusy(state, now) },
        affinity: relationship?.affinity ?? 0,
        followUp: signals.followUp,
        // 私聊没有"群热度"这个概念，传 0 而不是传私聊的消息密度
        groupActivity: channel === 'group' ? signals.groupActivity : 0,
      },
      parseAttentionPolicy(persona?.behaviorJson ?? null),
    );

    if (!attention.speak) {
      // 看了不回：状态照旧写回（把衰减持久化），关系只涨一点点
      await this.persistMind(instanceId, state);
      await this.persistRelationship(instanceId, message, relationship, now, false);
      return;
    }

    // ⑦ 看图（D033）：只有配了视觉模型才真的去下载图片
    const imageParts = await this.collectImageParts(message, config);
    const voiceReady =
      caps.media.voice && Boolean(config.ttsCredentialId && config.ttsModel);
    // 素材清单（D034）：模型只能用库里真实存在的名字，所以清单必须跟 prompt 一起给它
    const assetAliases = caps.media.image
      ? (await this.deps.assets.listForPrompt(instanceId, 12).catch(() => [])).map((item) => item.alias)
      : [];

    // ⑧ 拼 prompt（语气 + 只列真的可用的媒体通道）
    const assembled = persona
      ? assemblePrompt(persona, {
          peerName: message.sender.name || session.peerName,
          channel,
          selfName: owner.name,
          state: { mood: state.mood, energy: state.energy },
          capabilities: {
            imageReply: caps.media.image,
            voiceReply: voiceReady,
            assets: assetAliases,
          },
        })
      : {
          system: '你是一个有自己性格的人。',
          examples: [] as Array<{ role: 'user' | 'assistant'; content: string }>,
        };

    const messages: ChatMessage[] = [
      { role: 'system', content: assembled.system },
      ...assembled.examples,
      ...flattenWindow(window).map((m): ChatMessage => {
        const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user';
        // 群聊给 user 消息加发言人名，否则模型分不清谁说的
        const prefix = channel === 'group' && role === 'user' && m.senderName
          ? `${m.senderName}：`
          : '';
        const text = `${prefix}${m.content}`;
        // 图片只挂在"当前这条"上：历史图片不重发，否则每一轮都在为同一张图付费
        if (m.id === inbound.id && imageParts.length > 0) {
          return { role, content: [{ type: 'text', text }, ...imageParts] };
        }
        return { role, content: text };
      }),
    ];

    // ⑨ 调网关（有图时指定视觉模型：主模型多半看不见图）
    const result = await this.deps.gateway.chat({
      instanceId,
      ownerUserId: owner.ownerUserId,
      sessionId: session.id,
      purpose: 'chat',
      messages,
      ...(imageParts.length > 0 && config.visionModel ? { model: config.visionModel } : {}),
    });

    // ⑩ 引用决策
    const facts = windowQuoteFacts(window);
    const quoteDecision = decideQuote({
      channel,
      target: facts.target,
      after: facts.after,
      afterTotals: facts.afterTotals,
      incomingQuotesBot: message.replyToMessageId != null,
      selfId: owner.accountId,
      tendency: parseQuoteTendency(persona?.quoteTendency),
      now,
    });

    // ⑪ 出站（D033）：模型可以决定用图片或语音回，但**怎么发**由这里执行
    await this.deliver({
      message,
      instanceId,
      sessionId: session.id,
      selfId: owner.accountId,
      ownerUserId: owner.ownerUserId,
      config,
      caps,
      expression,
      busy: isBusy(state, now),
      now,
      raw: result.text,
      quoteTarget: quoteDecision.quote ? message.id : undefined,
      send,
    });

    // ⑫ 交互回写：回一条要花精力，关系往前走一点
    await this.persistMind(instanceId, applyReply(state));
    await this.persistRelationship(instanceId, message, relationship, now, true);
  }

  /**
   * 入站图片 → 多模态段。
   *
   * 没配视觉模型时**完全不下载**：图片只是 prompt 里的「[图片]」占位，
   * 下载了也没人看，白花一次外网请求（还可能把图床的限频引到自己身上）。
   */
  private async collectImageParts(
    message: InboundMessage,
    config: ResolvedConfig['config'],
  ): Promise<ContentPart[]> {
    if (!config.visionModel) {
      return [];
    }
    const urls = message.segments
      .filter((segment): segment is Extract<Segment, { type: 'image' }> => segment.type === 'image')
      .map((segment) => segment.url)
      .filter((url) => url.length > 0)
      .slice(0, 3);

    const parts: ContentPart[] = [];
    for (const url of urls) {
      const image = await this.deps.images.fetchAsDataUrl(url);
      if (image) {
        parts.push({ type: 'image_url', image_url: { url: image.dataUrl } });
      }
    }
    return parts;
  }

  /**
   * 出站编排：文本 + 图片合成一条，语音单独一条。
   *
   * 为什么语音要单独发：QQ 里一条消息同时带文字和语音，客户端常常只显示其中一个，
   * 而且语音条本身在聊天记录里就是一个独立气泡 —— 分开发也更像人。
   */
  private async deliver(input: {
    message: InboundMessage;
    instanceId: string;
    sessionId: string;
    selfId: string;
    ownerUserId: string;
    config: ResolvedConfig['config'];
    caps: PlatformCapabilities;
    /** 表达层参数（决策来自人设 behaviorJson.expression） */
    expression: ReturnType<typeof parseExpressionPolicy>;
    /** 当前是否忙碌（影响打字延迟） */
    busy: boolean;
    now: Date;
    raw: string;
    quoteTarget: string | undefined;
    send: SendAction;
  }): Promise<void> {
    const { message, config, caps, send } = input;
    const channel: 'private' | 'group' = message.session.kind === 'group' ? 'group' : 'private';
    const media = parseMediaIntent(input.raw, {
      allowImage: caps.media.image,
      allowVoice: caps.media.voice && Boolean(config.ttsCredentialId && config.ttsModel),
      imageHosts: config.imageHosts,
    });
    const bodyText = stripStrayMediaTags(media.text);
    // 语音发不出去时（平台不支持 / 没配 TTS），这句话按文字说
    const spokenFallback = media.voice ?? media.voiceAsText;

    // 存素材（D034）：只存**这条消息里真实存在的图**，不接受模型自己编的链接
    if (media.saves.length > 0) {
      const urls = message.segments
        .filter((segment): segment is Extract<Segment, { type: 'image' }> => segment.type === 'image')
        .map((segment) => segment.url);
      await this.deps.assets
        .saveFromUrls({ instanceId: input.instanceId, alias: media.saves[0] as string, urls })
        .catch(() => null);
    }

    // 语音先合成再发送：合成失败时才知道要不要把这句话并回正文
    let voicePath: string | null = null;
    if (media.voice && config.ttsCredentialId && config.ttsModel) {
      const tts = await this.deps.tts.synthesize({
        ownerUserId: input.ownerUserId,
        credentialId: config.ttsCredentialId,
        model: config.ttsModel,
        voice: config.ttsVoice,
        text: media.voice,
      });
      if (tts.kind === 'ok') {
        voicePath = tts.filePath;
      }
    }

    // 语音没合成出来（含"没配 TTS""平台不支持"）：把要说的话并进正文，不要让这条回复消失
    let textOut = bodyText;
    if (spokenFallback && !voicePath) {
      textOut = textOut ? `${textOut}\n${spokenFallback}` : spokenFallback;
    }

    // 图片（外链 + 素材库）：素材查不到就跳过，不编、不发空消息
    const images: string[] = [...media.images];
    for (const alias of media.uses) {
      const resolved = await this.deps.assets
        .resolveForSend(input.instanceId, alias)
        .catch(() => null);
      if (resolved) {
        images.push(resolved.filePath);
      }
    }

    // 表达层（M3-3）：拆条 + 每条前的延迟 + 群里回 @
    const parts = textOut
      ? planTextReply({
          text: textOut,
          channel,
          isMentioned: message.isMentioned,
          senderId: message.sender.id,
          quoted: input.quoteTarget !== undefined,
          ctx: { busy: input.busy, now: input.now },
          policy: input.expression,
          // 同一条消息重放得到同一套延迟/拆法，出问题能复现
          rand: seededRand(messageSeed(`${message.instanceId}:${channel}:${message.session.peerId}`, message.id)),
        })
      : [];

    // 引用与 @ 都只挂在第一条：一条回复只提醒对方一次才自然
    let quoted = false;
    const quoteRef = input.quoteTarget;

    for (const part of parts) {
      await this.wait(part.delayMs);
      const segments: Segment[] = [];
      if (part.mentionUserId) {
        segments.push({ type: 'at', userId: part.mentionUserId });
      }
      segments.push({ type: 'text', text: part.text });
      await send({
        kind: 'send',
        session: message.session,
        segments,
        ...(!quoted && quoteRef ? { replyToMessageId: quoteRef } : {}),
      });
      await this.deps.sessions.saveOutbound({
        sessionId: input.sessionId,
        content: part.text,
        senderId: input.selfId,
        replyToMessageId: !quoted && quoteRef ? quoteRef : null,
      });
      quoted = true;
    }

    if (images.length > 0) {
      // 发图前停一下：连续文字后立刻甩图，比文字本身更像机器人
      await this.wait(quoted ? input.expression.delay.mediaDelayMs : 0);
      await send({
        kind: 'send',
        session: message.session,
        segments: images.map((url): Segment => ({ type: 'image', url })),
        ...(!quoted && quoteRef ? { replyToMessageId: quoteRef } : {}),
      });
      await this.deps.sessions.saveOutbound({
        sessionId: input.sessionId,
        content: '[图片]',
        senderId: input.selfId,
        replyToMessageId: !quoted && quoteRef ? quoteRef : null,
      });
      quoted = true;
    }

    if (voicePath) {
      await this.wait(input.expression.delay.mediaDelayMs);
      await send({
        kind: 'send',
        session: message.session,
        segments: [{ type: 'voice', url: voicePath }],
      });
      await this.deps.sessions.saveOutbound({
        sessionId: input.sessionId,
        content: `[语音] ${media.voice ?? ''}`.trim(),
        senderId: input.selfId,
        replyToMessageId: null,
      });
    }
  }

  // ── 状态与关系（失败不阻断对话） ──

  private async loadMindState(instanceId: string, now: Date): Promise<MindState> {
    const stored = await this.deps.mind.loadState(instanceId).catch(() => null);
    const base = stored ?? createMindState(now);
    return decayState(base, now);
  }

  private async loadRelationship(
    instanceId: string,
    peerId: string,
  ): Promise<RelationshipSnapshot | null> {
    return this.deps.mind.loadRelationship(instanceId, peerId).catch(() => null);
  }

  private async persistMind(instanceId: string, state: MindState): Promise<void> {
    await this.deps.mind.saveState(instanceId, state).catch(() => undefined);
  }

  private async persistRelationship(
    instanceId: string,
    message: InboundMessage,
    relationship: RelationshipSnapshot | null,
    now: Date,
    replied: boolean,
  ): Promise<void> {
    const { affinity, lastInteractionAt } = nextAffinity(
      relationship,
      {
        channel: message.session.kind === 'group' ? 'group' : 'private',
        replied,
        mentioned: message.isMentioned,
        textLength: message.plainText.length,
      },
      now,
    );
    await this.deps.mind
      .saveRelationship({
        instanceId,
        peerId: message.sender.id,
        nickname: message.sender.name || relationship?.nickname || null,
        affinity,
        lastInteractionAt,
      })
      .catch(() => undefined);
  }

  private async handleFailure(message: InboundMessage, send: SendAction, err: Error): Promise<void> {
    // 没解锁：需要 owner 登录，不是"故障"。静默，避免每条消息都刷兜底话术
    if (err instanceof KeyLockedError) {
      return;
    }

    const reason: SpeakFailureReason = err instanceof GatewayFailedError ? err.reason : 'provider';
    const slot = faultToSlot(reason);
    const channel: 'private' | 'group' = message.session.kind === 'group' ? 'group' : 'private';

    const persona = await this.deps.pipeline.findActivePersona(message.instanceId).catch(() => null);
    const texts = parseFallbacks(persona?.fallbacksJson ?? null);
    const template = resolveFallback(texts, slot, channel, {
      nickname: message.sender.name,
      groupName: message.session.peerId,
    });

    const scope = `${message.instanceId}:${message.session.peerId}`;
    const decision = decideSpeak(slot, {
      spokenAt: this.fallbackLogFor(scope, slot),
      hasTemplate: template !== null,
      now: this.now(),
    });

    if (!decision.speak || template === null) {
      return;
    }

    this.recordFallback(scope, slot);
    const action: OutboundAction = {
      kind: 'send',
      session: message.session,
      segments: [{ type: 'text', text: template }],
    };
    // 兜底发送失败也不抛：这条链路已经在异常处理里，再抛就丢了
    await send(action).catch(() => undefined);
  }

  private fallbackLogFor(scope: string, slot: string): Date[] {
    let log = this.fallbackLog.get(scope);
    if (!log) {
      log = new Map();
      this.fallbackLog.set(scope, log);
    }
    return log.get(slot) ?? [];
  }

  private recordFallback(scope: string, slot: string): void {
    const log = this.fallbackLog.get(scope) ?? new Map();
    const list = log.get(slot) ?? [];
    list.push(this.now());
    log.set(slot, list);
    this.fallbackLog.set(scope, log);
  }
}
