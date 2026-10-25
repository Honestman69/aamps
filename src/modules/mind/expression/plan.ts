/**
 * 表达层总装：拆条 + 延迟 + 回 @（ARCHITECTURE 6.4）。
 *
 * 这里只做**计划**，不发送、不 sleep。原因：延迟必须由调用方执行，而"怎么等"
 * 属于运行时（测试里要能瞬间跑完）。纯函数也让"这条会被拆成几条、每条等多久"可断言。
 *
 * ## 回 @ 的一条取舍
 *
 * 群里被 @ 时，如果同时用了引用回复，就**不再 @**：引用本身已经带上了被回复人的提醒，
 * 两条一起出现会重复打扰，真人不会这么干。所以 `quoted = true` 时跳过 @。
 */

import type { DelayContext, DelayPolicy } from './delay';
import {
  DEFAULT_DELAY_POLICY,
  clampTotalDelays,
  readDelayMs,
  typingDelayMs,
} from './delay';
import { DEFAULT_SPLIT_POLICY, type SplitPolicy, splitMessage } from './split';

export type ExpressionPolicy = {
  split: SplitPolicy;
  delay: DelayPolicy;
  /** 群里被 @ 时先 @ 回去（关掉就只回内容） */
  mentionBack: boolean;
};

export const DEFAULT_EXPRESSION_POLICY: ExpressionPolicy = {
  split: DEFAULT_SPLIT_POLICY,
  delay: DEFAULT_DELAY_POLICY,
  mentionBack: true,
};

function isUnitNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function pickNumber(
  source: Record<string, unknown>,
  key: string,
  fallback: number,
  range: { min: number; max: number },
): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  if (value < range.min || value > range.max) {
    return fallback;
  }
  return value;
}

/**
 * 从 `Persona.behaviorJson.expression` 解析。与发言决策同一套路：
 * **逐字段回落**，一个字段写错不连累其它字段。
 */
export function parseExpressionPolicy(raw: string | null): ExpressionPolicy {
  if (!raw) {
    return DEFAULT_EXPRESSION_POLICY;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_EXPRESSION_POLICY;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return DEFAULT_EXPRESSION_POLICY;
  }
  const block = (parsed as Record<string, unknown>).expression;
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    return DEFAULT_EXPRESSION_POLICY;
  }
  const source = block as Record<string, unknown>;

  return {
    split: {
      maxCharsPerSegment: pickNumber(source, 'maxCharsPerSegment', DEFAULT_SPLIT_POLICY.maxCharsPerSegment, {
        min: 10,
        max: 200,
      }),
      maxSegments: pickNumber(source, 'maxSegments', DEFAULT_SPLIT_POLICY.maxSegments, {
        min: 1,
        max: 6,
      }),
      splitChance: isUnitNumber(source.splitChance)
        ? source.splitChance
        : DEFAULT_SPLIT_POLICY.splitChance,
    },
    delay: {
      readBaseMs: pickNumber(source, 'readBaseMs', DEFAULT_DELAY_POLICY.readBaseMs, {
        min: 0,
        max: 10_000,
      }),
      readPerCharMs: pickNumber(source, 'readPerCharMs', DEFAULT_DELAY_POLICY.readPerCharMs, {
        min: 0,
        max: 500,
      }),
      readJitter: isUnitNumber(source.readJitter)
        ? source.readJitter
        : DEFAULT_DELAY_POLICY.readJitter,
      typingCps: pickNumber(source, 'typingCps', DEFAULT_DELAY_POLICY.typingCps, {
        min: 0.5,
        max: 50,
      }),
      busyFactor: pickNumber(source, 'busyFactor', DEFAULT_DELAY_POLICY.busyFactor, {
        min: 1,
        max: 10,
      }),
      nightFactor: pickNumber(source, 'nightFactor', DEFAULT_DELAY_POLICY.nightFactor, {
        min: 1,
        max: 10,
      }),
      mediaDelayMs: pickNumber(source, 'mediaDelayMs', DEFAULT_DELAY_POLICY.mediaDelayMs, {
        min: 0,
        max: 10_000,
      }),
      maxTotalMs: pickNumber(source, 'maxTotalMs', DEFAULT_DELAY_POLICY.maxTotalMs, {
        min: 500,
        max: 120_000,
      }),
    },
    mentionBack: source.mentionBack === false ? false : DEFAULT_EXPRESSION_POLICY.mentionBack,
  };
}

export type PlannedPart = {
  text: string;
  /** 这条发出前等多久 */
  delayMs: number;
  /** 需要在这条前面 @ 谁（null = 不 @） */
  mentionUserId: string | null;
};

export function planTextReply(input: {
  text: string;
  channel: 'private' | 'group';
  isMentioned: boolean;
  /** 对方 id（群里被 @ 时 @ 回去） */
  senderId: string;
  /** 已经用了引用回复 */
  quoted: boolean;
  ctx: DelayContext;
  policy: ExpressionPolicy;
  /** 注入随机源（可复现） */
  rand: () => number;
}): PlannedPart[] {
  const { policy } = input;
  const parts = splitMessage(input.text, policy.split, input.rand);
  if (parts.length === 0) {
    return [];
  }

  const mentionUserId =
    input.channel === 'group' && input.isMentioned && input.policy.mentionBack && !input.quoted
      ? input.senderId
      : null;

  const delays = parts.map((part, index) =>
    index === 0
      ? readDelayMs(part.length, input.ctx, policy.delay, input.rand)
      : typingDelayMs(part.length, input.ctx, policy.delay),
  );
  const clamped = clampTotalDelays(delays, policy.delay.maxTotalMs);

  return parts.map((text, index) => ({
    text,
    delayMs: clamped[index] ?? 0,
    // @ 只挂在第一条：后面几条不需要重复叫对方
    mentionUserId: index === 0 ? mentionUserId : null,
  }));
}
