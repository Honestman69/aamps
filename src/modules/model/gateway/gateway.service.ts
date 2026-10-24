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

import { KeyLockedError } from '@newjob/contracts';

import { decryptWithDek } from '../../../common/crypto';
import { RuntimeKeyStore } from '../../auth/runtime-key-store';
import type { AgentConfig } from '../../config/types';
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
};

/** 全部候选都失败：带上最后一次原因，交给上层决定怎么说/怎么说不出声 */
export class GatewayFailedError extends Error {
  constructor(
    readonly reason: UnavailableReason | 'no_candidate',
    readonly attempts: GatewayAttempt[],
  ) {
    super(`模型调用失败：${reason}`);
    this.name = 'GatewayFailedError';
  }
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
    },
  ) {}

  private now(): Date {
    return this.deps.clock?.() ?? new Date();
  }

  private async wait(ms: number): Promise<void> {
    if (this.deps.sleep) {
      return this.deps.sleep(ms);
    }
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async chat(input: GatewayInput): Promise<GatewayResult> {
    const { config } = await this.deps.config.get(input.instanceId, { sessionId: input.sessionId });
    const model = input.purpose === 'chat' ? config.modelMain : config.modelCheap;

    // 必须先解锁：Key 是密文，没有 DEK 就没有明文（D005）
    const dek = this.deps.keyStore.get(input.sessionId);

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
