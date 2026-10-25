/**
 * ModelGateway：所有 LLM 调用的唯一出口（AGENTS 硬性规则 4）。
 *
 * 它负责四件事，且只负责这四件事：
 *   1. **选路**：先主 Key，再按优先级换同 Provider 的其他 Key；跳过冷却中的。
 *   2. **重试**：只对"可能自愈"的失败重试（网络 / 5xx / 限流）。
 *   3. **熔断**：Key 级失败（余额、鉴权）立刻冷却该 Key，但**不删、不禁用**（D025）。
 *   4. **记账**：成功调用写一行 `ModelUsage`，金额按当次 Key 的目录价算（D024）。
 *
 * 它**不负责**"要不要说话"——那是表达层/策略层的事。失败时它只把原因抛给上层：
 * 上层按 D025 决定是回一句兜底话术，还是静默。
 *
 * 解密边界：`apiKeyEnc` 在这里解成明文，只活在本次调用的栈上，用完即弃；不进日志、不进错误消息。
 */

import { Logger } from '@nestjs/common';
import { KeyLockedError } from '@newjob/contracts';

import { decryptWithDek } from '../../../common/crypto';
import { RuntimeKeyStore } from '../../auth/runtime-key-store';
import type { AgentConfig } from '../../config/types';
import { decideBudget } from '../metering/budget';
import { priceUsage } from '../metering/price';
import { findProviderPreset } from '../providers/presets';
import { openAiCompatibleChat, type ChatMessage, type ProviderChatResponse } from '../providers/openai-compatible';
import { classifyFailure, isKeyLevelFailure, type UnavailableReason } from './classify';
import type { GatewayCandidate, IGatewayRepository } from './ports';

export type GatewayPurpose = 'chat' | 'think' | 'reflection';

export type GatewayInput = {
  instanceId: string;
  ownerUserId: string;
  sessionId: string;
  purpose: GatewayPurpose;
  messages: ChatMessage[];
  /**
   * 指定模型（D033）：看图必须走视觉模型，不能用 `modelMain`，
   * 否则图片会让不支持 vision 的模型直接 400。
   * 指定后**不参与预算降级**——没有比视觉模型更便宜的"能看图"的替代。
   */
  model?: string;
  /** 外部取消（锁定/停机） */
  signal?: AbortSignal;
};

export type GatewayAttempt = {
  credentialId: string;
  model: string;
  reason: UnavailableReason | 'unsupported_protocol';
  retried: number;
};

export type GatewayResult = {
  text: string;
  model: string;
  provider: string;
  credentialId: string;
  usage: { tokenIn: number; tokenOut: number };
  costCents: number;
  /** 前面失败的尝试，用于排查"为什么最后用了备 Key" */
  attempts: GatewayAttempt[];
  /** 本次是否因超预算被降级到了 cheap 模型（D024）。没超预算时不存在 */
  budget?: { downgraded: boolean; over: 'daily' | 'monthly' };
};

/**
 * 网关会把调用结束在哪些原因上。
 *
 * `budget_exhausted` 不在 `UnavailableReason` 里，因为它不是"厂商那边的问题"——
 * 是我方限额（D024）。但上层要用同一套话术映射，所以并列在这里，
 * 由 `persona/fault-slot` 统一翻译成槽位。
 */
export type GatewayFailureReason = UnavailableReason | 'no_candidate' | 'budget_exhausted';

/** 预算失败的细节：只放数字与枚举，**不放任何密钥材料** */
export type BudgetFailureDetail = {
  over: 'daily' | 'monthly';
  because: 'policy' | 'cannotDowngrade';
  todayCents: number;
  monthCents: number;
  dailyBudgetCents: number;
  monthlyBudgetCents: number;
};

/** 全部候选都失败：带上最后一次原因，交给上层决定怎么说/怎么说不出声 */
export class GatewayFailedError extends Error {
  constructor(
    readonly reason: GatewayFailureReason,
    readonly attempts: GatewayAttempt[],
    readonly budget?: BudgetFailureDetail,
  ) {
    super(`模型调用失败：${reason}`);
    this.name = 'GatewayFailedError';
  }
}

function defaultWarn(message: string): void {
  // 用 Nest 的 Logger 而不是 console：它带上下文标签，且便于统一改日志后端
  new Logger('ModelGateway').warn(message);
}

const MAX_ATTEMPTS_PER_KEY = 2;
const DEFAULT_RETRY_DELAY_MS = 300;

export class GatewayService {
  constructor(
    private readonly deps: {
      repo: IGatewayRepository;
      config: { get(instanceId: string, options?: { sessionId?: string | null }): Promise<{ config: AgentConfig }> };
      keyStore: RuntimeKeyStore;
      clock?: () => Date;
      sleep?: (ms: number) => Promise<void>;
      retryDelayMs?: number;
      /** 告警出口。默认走 Nest Logger；测试里注入收集器，避免污染输出 */
      warn?: (message: string) => void;
    },
  ) {}

  private now(): Date {
    return this.deps.clock?.() ?? new Date();
  }

  /**
   * 同一条告警一小时内只打一次。
   *
   * 这个 Map 是**纯粹为日志节流**的运行时状态：丢了最多多打几条日志，
   * 不符合 SECURITY 3.3 里"不可重建状态"的定义，所以不落库。
   */
  private readonly warned = new Map<string, number>();

  private warnOnce(key: string, message: string, cooldownMs = 60 * 60 * 1000): void {
    const now = this.now().getTime();
    const last = this.warned.get(key);
    if (last !== undefined && now - last < cooldownMs) {
      return;
    }
    this.warned.set(key, now);
    (this.deps.warn ?? defaultWarn)(message);
  }

  private async wait(ms: number): Promise<void> {
    if (this.deps.sleep) {
      return this.deps.sleep(ms);
    }
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async chat(input: GatewayInput): Promise<GatewayResult> {
    const { config } = await this.deps.config.get(input.instanceId, { sessionId: input.sessionId });

    // 必须先解锁：Key 是密文，没有 DEK 就没有明文（D005）。
    // 注意这里按 **ownerUserId** 取，而不是 chat sessionId：消息来自协议端，
    // 没有登录会话可用（见 RuntimeKeyStore.getForUser 的说明）。
    const dek = this.deps.keyStore.getForUser(input.ownerUserId);

    // 预算判定放在解锁**之后**：两个原因可能同时成立（没解锁 + 已超预算），
    // 报"预算耗尽"会让 owner 去改配置，而真正的问题是他自己还没登录。
    // 放在候选查询**之前**：block 时根本不需要知道有没有 Key，省一次查询。
    const budget = await this.resolveBudget(input, config);
    const model = budget.model;

    const candidates = await this.deps.repo.listCandidates(input.ownerUserId);
    if (candidates.length === 0) {
      throw new GatewayFailedError('no_candidate', []);
    }

    // 配置里指定的 Key 优先，其余按 priority
    const ordered = [...candidates].sort((a, b) => {
      if (a.credentialId === config.credentialId) return -1;
      if (b.credentialId === config.credentialId) return 1;
      return a.priority - b.priority;
    });

    const attempts: GatewayAttempt[] = [];
    let lastReason: UnavailableReason | 'no_candidate' = 'no_candidate';

    for (const candidate of ordered) {
      const protocol = findProviderPreset(candidate.provider)?.protocol ?? 'openai-compatible';
      if (protocol !== 'openai-compatible') {
        // 当前只实现了一个协议；anthropic / gemini 等接入时再补，别假装能调
        attempts.push({
          credentialId: candidate.credentialId,
          model,
          reason: 'unsupported_protocol',
          retried: 0,
        });
        lastReason = 'provider';
        continue;
      }

      const apiKey = this.decryptKey(candidate, dek);
      let retried = 0;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_KEY; attempt += 1) {
        try {
          const response = await this.callProvider(candidate, apiKey, {
            model,
            messages: input.messages,
            temperature: config.modelTemperature,
          }, input.signal);

          const price = priceUsage({
            catalogJson: candidate.catalogJson,
            model: response.model,
            tokenIn: response.usage.tokenIn,
            tokenOut: response.usage.tokenOut,
          });
          if (!price.priced) {
            // 不抛错（聊天不能因为少个价格就断），但必须说出来：
            // 记 0 分意味着预算永远不会触发，这是"限额静默失效"，比账单不准更严重。
            this.warnOnce(
              `unpriced:${candidate.credentialId}:${response.model}`,
              `Key ${candidate.credentialId} 的目录里没有模型 ${response.model} 的价格，本次花费记为 0，` +
                `该实例的预算不会因此触发。请在凭据里补上目录价。`,
            );
          }

          await this.deps.repo.recordUsage({
            instanceId: input.instanceId,
            credentialId: candidate.credentialId,
            ownerUserId: input.ownerUserId,
            provider: candidate.provider,
            model: response.model,
            tokenIn: response.usage.tokenIn,
            tokenOut: response.usage.tokenOut,
            costCents: price.costCents,
            sessionId: input.sessionId,
            purpose: input.purpose,
          });

          return {
            text: response.text,
            model: response.model,
            provider: candidate.provider,
            credentialId: candidate.credentialId,
            usage: response.usage,
            costCents: price.costCents,
            attempts,
            ...(budget.over ? { budget: { downgraded: budget.downgraded, over: budget.over } } : {}),
          };
        } catch (err) {
          const reason = this.reasonOf(err);
          retried = attempt - 1;
          lastReason = reason;

          // Key 级失败：换 Key 比重试有意义；同时给它打上冷却（不删、不禁用）
          if (isKeyLevelFailure(reason)) {
            await this.deps.repo.markCooldown(
              candidate.credentialId,
              reason,
              new Date(this.now().getTime() + this.cooldownFor(reason)),
            );
            attempts.push({ credentialId: candidate.credentialId, model, reason, retried });
            break;
          }

          // 可自愈：同一个 Key 再试一次
          if (attempt < MAX_ATTEMPTS_PER_KEY) {
            await this.wait(this.deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
            continue;
          }

          attempts.push({ credentialId: candidate.credentialId, model, reason, retried });
        }
      }
    }

    throw new GatewayFailedError(lastReason, attempts);
  }

  /**
   * 判定本次该用哪个模型，超预算时按策略降级或直接拒绝（D024）。
   *
   * 两个额度都是 0 时跳过整段逻辑：这是新装实例的默认，不该为它多查两次库。
   */
  private async resolveBudget(
    input: GatewayInput,
    config: AgentConfig,
  ): Promise<{ model: string; downgraded: boolean; over?: 'daily' | 'monthly' }> {
    const original = input.model ?? (input.purpose === 'chat' ? config.modelMain : config.modelCheap);

    if (config.dailyBudgetCents === 0 && config.monthlyBudgetCents === 0) {
      return { model: original, downgraded: false };
    }

    const usage = await this.deps.repo.usageTotals(input.instanceId, this.budgetWindow());
    if (usage.unpricedCalls > 0) {
      // 这些调用记了 0 分，所以"已花"比真实值低 —— 预算可能提前放过。
      // 不据此拦截（宁可少拦，不可误拦），但要让 owner 知道数字不准。
      this.warnOnce(
        `unpriced-usage:${input.instanceId}`,
        `实例 ${input.instanceId} 本月有 ${usage.unpricedCalls} 次调用没有目录价、记为 0 分，` +
          `预算用量偏低，可能比预期更晚触发。`,
      );
    }
    const decision = decideBudget(
      {
        dailyBudgetCents: config.dailyBudgetCents,
        monthlyBudgetCents: config.monthlyBudgetCents,
        budgetPolicy: config.budgetPolicy,
      },
      usage,
      { mainModel: config.modelMain, cheapModel: config.modelCheap, purpose: input.purpose },
    );

    if (decision.mode === 'block') {
      throw new GatewayFailedError('budget_exhausted', [], {
        over: decision.over,
        because: decision.because,
        todayCents: usage.todayCents,
        monthCents: usage.monthCents,
        dailyBudgetCents: config.dailyBudgetCents,
        monthlyBudgetCents: config.monthlyBudgetCents,
      });
    }

    if (decision.mode === 'downgrade') {
      // 视觉请求不能降级到看不见图的模型：那样只会得到一条答非所问的回复，
      // 还不如多花一点钱把这张图看懂（D033）
      if (input.model) {
        return { model: input.model, downgraded: false, over: decision.over };
      }
      return { model: decision.model, downgraded: true, over: decision.over };
    }

    return { model: original, downgraded: false };
  }

  /**
   * "今天"和"本月"的边界，按**本地时区**算。
   *
   * 用 UTC 会让日预算在早上 8 点重置（东八区），用户会觉得"限额自己变了"。
   */
  private budgetWindow(): { dayStart: Date; monthStart: Date } {
    const now = this.now();
    const dayStart = new Date(now.getTime());
    dayStart.setHours(0, 0, 0, 0);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    return { dayStart, monthStart };
  }

  private decryptKey(candidate: GatewayCandidate, dek: Buffer): string {
    try {
      return decryptWithDek(candidate.apiKeyEnc, dek);
    } catch {
      // 解不开 = 密文坏了或 DEK 不匹配。当成 auth 失败处理：换下一把 Key
      throw new KeyLockedError();
    }
  }

  private async callProvider(
    candidate: GatewayCandidate,
    apiKey: string,
    request: { model: string; messages: ChatMessage[]; temperature: number },
    signal?: AbortSignal,
  ): Promise<ProviderChatResponse> {
    return openAiCompatibleChat(request, {
      baseUrl: candidate.baseUrl ?? findProviderPreset(candidate.provider)?.baseUrl ?? '',
      apiKey,
      authStyle: (candidate.authStyle as 'bearer' | 'x-api-key' | 'query') ?? 'bearer',
      apiVersion: candidate.apiVersion,
      timeoutMs: 30_000,
      signal,
    });
  }

  private reasonOf(err: unknown): UnavailableReason {
    const classified = (err as { classified?: { reason: UnavailableReason } }).classified;
    if (classified?.reason) {
      return classified.reason;
    }
    // 未归类的异常（代码 bug、解析失败）按 provider 处理：可重试一次，然后换 Key
    return classifyFailure({ networkError: true }).reason;
  }

  private cooldownFor(reason: UnavailableReason): number {
    return reason === 'auth' ? 60 * 60 * 1000 : 30 * 60 * 1000;
  }
}
