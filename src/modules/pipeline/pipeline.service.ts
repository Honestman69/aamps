/**
 * Pipeline：消息主链路（M2 最小闭环）。
 *
 * 一条入站消息走完这条链：
 *
 * ```
 * InboundMessage
 *   → 落库（upsert session + 存入站消息）
 *   → 取 owner + 人设
 *   → buildWindow（D031：target 必须在窗口里）
 *   → assemblePrompt（D020：种子 → 情境 → 软禁区）
 *   → ModelGateway.chat（D024 预算 / D025 熔断 / 记账）
 *   → decideQuote（D030：必要性 + 倾向）
 *   → 出站 + 落库
 * ```
 *
 * 失败时（`GatewayFailedError`）走兜底：按 D028 用 `faultToSlot` 映射到话术槽位，
 * 再按 `decideSpeak` 限频，`resolveFallback` 取文本，可能静默。
 *
 * ## 这条链刻意**没做**的事（属于 M3）
 *
 * - attention（要不要回）—— 现在是有消息就回
 * - think（内心独白）—— 现在单阶段直出
 * - moderate（输出审核）—— 现在直接发
 * - express（拆条/打字延迟）—— 现在单条原样
 *
 * 这些是 M3 的 Pipe，现在不做是为了让"私聊能对话"这条最小路径先跑通。
 */

import type { InboundMessage, OutboundAction } from '@newjob/contracts';
import { KeyLockedError } from '@newjob/contracts';

import type { AgentConfig } from '../config/types';
import { GatewayFailedError, GatewayService } from '../model/gateway/gateway.service';
import type { ChatMessage } from '../model/providers/openai-compatible';
import { parseFallbacks, resolveFallback } from '../persona/fallbacks';
import { decideSpeak, faultToSlot, type SpeakFailureReason } from '../persona/fault-slot';
import { decideQuote, parseQuoteTendency } from '../persona/quote';
import { assemblePrompt } from '../persona/prompt';
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
  config: {
    get(instanceId: string, options?: { sessionId?: string | null }): Promise<{ config: AgentConfig }>;
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

    // ① 落库：会话 + 入站消息
    const session = await this.deps.sessions.ensureSession({
      instanceId,
      kind: message.session.kind,
      peerId: message.session.peerId,
      peerName: message.sender.name,
    });
    const inbound = await this.deps.sessions.saveInbound({ sessionId: session.id, message });

    // ② 取 owner + 人设
    const owner = await this.deps.pipeline.findOwner(instanceId);
    if (!owner) {
      return; // 实例没了，无处可发
    }
    const persona = await this.deps.pipeline.findActivePersona(instanceId);

    // ③ 取窗口
    const channel = message.session.kind === 'group' ? 'group' : 'private';
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
      now: this.now(),
    });
    if (!window) {
      return;
    }

    // ④ 拼 prompt
    const { config } = await this.deps.config.get(instanceId, { sessionId: session.id });
    const assembled = persona
      ? assemblePrompt(persona, {
          peerName: message.sender.name || session.peerName,
          channel,
          selfName: owner.name,
        })
      : { system: '你是一个有自己性格的人。', examples: [] as Array<{ role: 'user' | 'assistant'; content: string }> };

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

    // ⑤ 调网关
    const result = await this.deps.gateway.chat({
      instanceId,
      ownerUserId: owner.ownerUserId,
      sessionId: session.id,
      purpose: 'chat',
      messages,
    });

    // ⑥ 引用决策
    const facts = windowQuoteFacts(window);
    const quoteDecision = decideQuote({
      channel,
      target: facts.target,
      after: facts.after,
      afterTotals: facts.afterTotals,
      incomingQuotesBot: message.replyToMessageId != null,
      selfId: owner.accountId,
      tendency: parseQuoteTendency(persona?.quoteTendency),
      now: this.now(),
    });

    // ⑦ 出站 + 落库
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
