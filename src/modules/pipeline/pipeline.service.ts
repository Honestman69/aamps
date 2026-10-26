/**
 * Pipeline：消息主链路**编排**。
 *
 * 这个文件只做四件事：**入队串行、跑管道、兜底、清理**。
 * 具体每一步在 `pipes/` 下的 13 个文件里 —— 每个都能单独读、单独改、单独测。
 *
 * ```
 * handle() ──按 instanceId+会话 入队──▶ runOnce() ──▶ 13 个 pipe 依次执行
 *                                          │
 *                                          └─ 任一步 throw ──▶ handleFailure()（兜底话术，可能静默）
 * ```
 *
 * ## 为什么串行
 *
 * 表达层会"等几秒再发"（拟人）。不串行的话，两条相隔 1 秒的消息会各自等各自的延迟，
 * 最后交错发出去 —— 比秒回还不像人。串行之后，同一个人的第二条消息会等它把第一条说完。
 * 队列按 `instanceId + 会话` 分片，不阻塞别的会话；进程内 Map，丢了只影响"同时来两条"。
 *
 * ## 两种"不回"必须区分
 *
 * - **DROP**：这一步判定"不该回"（治理、窗口空、attention 判掉），安静结束；
 * - **throw**：出了故障（网关超时、Key 没解锁），交给 `handleFailure` 按 D028 决定
 *   说兜底话术还是静默。
 *
 * 混成一种的话，要么欠费时每句话都回"我有点累"，要么模型挂了却一声不吭。
 */

import type { InboundMessage, OutboundAction, PlatformCapabilities } from '@newjob/contracts';
import { KeyLockedError } from '@newjob/contracts';

import { GatewayFailedError } from '../model/gateway/gateway.service';
import { parseFallbacks, resolveFallback } from '../persona/fallbacks';
import { decideSpeak, faultToSlot, type SpeakFailureReason } from '../persona/fault-slot';
import type { SendAction, PipelineDeps } from './deps';
import { assertPipeGraph, createContext, INBOUND_PIPES, runPipeChain } from './pipes';

export type { PipelineDeps, SendAction } from './deps';

export class PipelineService {
  /** scope（instanceId:peerId）→ slot → 发言时间点。纯限频状态，丢了只多几句 */
  private readonly fallbackLog = new Map<string, Map<string, Date[]>>();

  /** 每个会话的串行队列（见文件头） */
  private readonly sessionQueue = new Map<string, Promise<void>>();

  constructor(private readonly deps: PipelineDeps) {
    // 启动即校验：pipe 顺序错了、字段没人提供、两个 pipe 抢着写同一字段，都在这里炸
    assertPipeGraph(INBOUND_PIPES);
  }

  private now(): Date {
    return this.deps.clock?.() ?? new Date();
  }

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

  /**
   * 处理一条入站消息。**永不 throw** —— 任何失败都转成"回兜底话术或静默"。
   *
   * @param send 出站回调。作为参数而不是依赖注入：send 绑定到"当前这条连接的 adapter"，
   *             每个实例的 adapter 不同，不能全局注入一个。
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

  /** 跑一条消息并吞掉所有异常（永不 throw），串行队列里跑的就是它 */
  private async runOnce(
    message: InboundMessage,
    send: SendAction,
    capabilities: PlatformCapabilities,
  ): Promise<void> {
    try {
      await this.runPipes(message, send, capabilities);
    } catch (err) {
      await this.handleFailure(message, send, err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** 管道本体：只有"建上下文 + 依次执行 + 遇 DROP 结束"三句 */
  private async runPipes(
    message: InboundMessage,
    send: SendAction,
    caps: PlatformCapabilities,
  ): Promise<void> {
    const ctx = createContext({
      message,
      send,
      caps,
      deps: this.deps,
      channel: message.session.kind === 'group' ? 'group' : 'private',
      wait: (ms: number) => this.wait(ms),
    });

    await runPipeChain(ctx, INBOUND_PIPES);
  }

  /**
   * 故障兜底（D026 / D028）：按原因分槽位 + 限频，可能静默。
   *
   * 不放进 pipe 的原因：它处理的是"上面某一步抛了"，属于编排层的职责；
   * 塞进管道会变成"自己 catch 自己"。
   */
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
