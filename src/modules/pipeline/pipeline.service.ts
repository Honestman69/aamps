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

import type { InboundMessage, OutboundAction } from '@newjob/contracts';
import { KeyLockedError } from '@newjob/contracts';

import type { ResolvedConfig } from '../config/types';
import { decideAttention } from '../mind/attention/attention';
import { parseAttentionPolicy } from '../mind/attention/policy';
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
import type { ChatMessage } from '../model/providers/openai-compatible';
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
  config: {
    get(
      instanceId: string,
      options?: { sessionId?: string | null },
    ): Promise<Pick<ResolvedConfig, 'config' | 'sessionFlags'>>;
  };
  gateway: GatewayService;
  clock?: () => Date;
};

/** 出站回调：生产里是当前实例 adapter 的 send，测试里是收集器 */
export type SendAction = (action: OutboundAction) => Promise<{ messageId: string }>;

export class PipelineService {
  /** scope（instanceId:sessionId）→ slot → 发言时间点。纯限频状态，丢了只多几句 */
  private readonly fallbackLog = new Map<string, Map<string, Date[]>>();

  constructor(private readonly deps: PipelineDeps) {}

  private now(): Date {
    return this.deps.clock?.() ?? new Date();
  }

  /**
   * 处理一条入站消息。永不 throw —— 任何失败都转成"回兜底话术或静默"。
   *
   * @param send 出站回调。之所以作为参数而不是依赖注入：send 绑定到"当前这条连接
   *             的 adapter"，每个实例的 adapter 不同，不能全局注入一个。
   */
  async handle(message: InboundMessage, send: SendAction): Promise<void> {
    if (!message.plainText.trim()) {
      return;
    }
    try {
      await this.process(message, send);
    } catch (err) {
      await this.handleFailure(message, send, err instanceof Error ? err : new Error(String(err)));
    }
  }

  private async process(message: InboundMessage, send: SendAction): Promise<void> {
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

    // ⑦ 拼 prompt（带上此刻的语气）
    const assembled = persona
      ? assemblePrompt(persona, {
          peerName: message.sender.name || session.peerName,
          channel,
          selfName: owner.name,
          state: { mood: state.mood, energy: state.energy },
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
        return { role, content: `${prefix}${m.content}` };
      }),
    ];

    // ⑧ 调网关
    const result = await this.deps.gateway.chat({
      instanceId,
      ownerUserId: owner.ownerUserId,
      sessionId: session.id,
      purpose: 'chat',
      messages,
    });

    // ⑨ 引用决策
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

    // ⑩ 出站 + 落库
    const action: OutboundAction = {
      kind: 'send',
      session: message.session,
      segments: [{ type: 'text', text: result.text }],
      ...(quoteDecision.quote ? { replyToMessageId: message.id } : {}),
    };
    await send(action);
    await this.deps.sessions.saveOutbound({
      sessionId: session.id,
      content: result.text,
      senderId: owner.accountId,
      replyToMessageId: quoteDecision.quote ? message.id : null,
    });

    // ⑪ 交互回写：回一条要花精力，关系往前走一点
    await this.persistMind(instanceId, applyReply(state));
    await this.persistRelationship(instanceId, message, relationship, now, true);
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
