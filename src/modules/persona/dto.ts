/**
 * 人设的入参 Schema 与对外 DTO。
 *
 * ## 三个刻意的设计
 *
 * 1. **入参是对象，不是 JSON 字符串。** 库里存的是 `identityJson` / `behaviorJson` 这些字段，
 *    但接口收的是结构化对象：让前端拼 JSON 字符串，等于把"序列化 + 语法正确"的责任
 *    推给最不该负责的一层，而且错了只能表现为"保存成功但没生效"。
 * 2. **全部 `.strict()`。** 写错一个字段名（`thresholdGrop`）应该 400，而不是静默忽略——
 *    否则用户会以为调过了，实际一点没变（`parseAttentionPolicy` 的回退逻辑会掩盖它）。
 * 3. **出参也是对象。** 前端不需要 `JSON.parse`；库里被手改坏的 JSON 在这里宽容回落成空结构，
 *    不让一条脏数据把整个编辑页打挂。
 */

import { z } from 'zod';

import { BadRequestError } from '@newjob/contracts';

import { QUOTE_TENDENCIES } from './quote';

const unit = z.number().min(0).max(1);

// ─────────────────────────── 行为参数（D032/D035/D036） ───────────────────────────

const attentionSchema = z
  .object({
    base: unit,
    privateBoost: unit,
    thresholdPrivate: unit,
    thresholdGroup: unit,
    thresholdBusy: unit,
    weights: z
      .object({
        mention: unit,
        topicMatch: unit,
        followUp: unit,
        groupVibe: unit,
        affinity: unit,
        lowEnergy: unit,
      })
      .partial()
      .strict(),
  })
  .partial()
  .strict();

const expressionSchema = z
  .object({
    maxCharsPerSegment: z.number().int().min(10).max(200),
    maxSegments: z.number().int().min(1).max(6),
    splitChance: unit,
    readBaseMs: z.number().int().min(0).max(10_000),
    readPerCharMs: z.number().int().min(0).max(500),
    readJitter: unit,
    typingCps: z.number().min(0.5).max(50),
    busyFactor: z.number().min(1).max(10),
    nightFactor: z.number().min(1).max(10),
    mediaDelayMs: z.number().int().min(0).max(10_000),
    maxTotalMs: z.number().int().min(500).max(120_000),
    mentionBack: z.boolean(),
  })
  .partial()
  .strict();

const thinkSchema = z.object({ enabled: z.boolean() }).partial().strict();

/** `Persona.behaviorJson` 的结构化视图 */
export const behaviorSchema = z
  .object({
    attention: attentionSchema,
    expression: expressionSchema,
    think: thinkSchema,
  })
  .partial()
  .strict();

// ─────────────────────────── 故障话术（D026/D028） ───────────────────────────

/** `null` 是**合法值**：明确表示"这种情况不说话" */
const fallbackSlotSchema = z
  .object({
    private: z.string().trim().max(200).nullable(),
    group: z.string().trim().max(200).nullable(),
  })
  .partial()
  .strict();

const fallbacksSchema = z
  .object({
    shortOutage: fallbackSlotSchema,
    longOutage: fallbackSlotSchema,
    budgetLimit: fallbackSlotSchema,
  })
  .partial()
  .strict();

// ─────────────────────────── 人设内容 ───────────────────────────

const identitySchema = z
  .object({
    name: z.string().trim().max(40),
    age: z.string().trim().max(20),
    gender: z.string().trim().max(20),
    role: z.string().trim().max(60),
    background: z.string().trim().max(4000),
  })
  .partial()
  .strict();

const promptBlockSchema = z
  .object({
    key: z.string().trim().max(40),
    title: z.string().trim().max(60),
    content: z.string().trim().min(1).max(4000),
    enabled: z.boolean(),
    order: z.number().int().min(0).max(999),
  })
  .partial()
  .strict()
  .refine((value) => typeof value.content === 'string' && value.content.length > 0, {
    message: 'content 不能为空',
  });

const exampleSchema = z
  .object({
    user: z.string().trim().max(1000),
    assistant: z.string().trim().max(1000),
  })
  .partial()
  .strict()
  .refine(
    (value) =>
      (typeof value.user === 'string' && value.user.length > 0) ||
      (typeof value.assistant === 'string' && value.assistant.length > 0),
    { message: '示例至少要有一句 user 或 assistant' },
  );

const openingSchema = z
  .object({
    private: z.string().trim().max(500),
    groupMention: z.string().trim().max(500),
    proactive: z.string().trim().max(500),
  })
  .partial()
  .strict();

/**
 * 可编辑的内容字段。
 *
 * **全部 `.optional()`**：创建时只有 `name` 必填（新建一份人设不该被逼着一次填完
 * 背景故事、示例对话、故障话术）；更新时"没传"才是"别动这一列"。
 * 如果这里写成必填，前端就必须把每个字段都塞成 `null` 才能保存，而 `null` 与"没配"
 * 在语义上是两件事（后者要保留库里的默认值）。
 */
const contentFields = {
  avatar: z.string().trim().url('必须是合法地址').max(500).nullable().optional(),
  tagline: z.string().trim().max(120).optional(),
  identity: identitySchema.optional(),
  promptBlocks: z.array(promptBlockSchema).max(30).optional(),
  examples: z.array(exampleSchema).max(20).optional(),
  opening: openingSchema.optional(),
  /** 软禁区（可协商）。**不是红线**：红线独立存放，反思与 owner 都改不了（D020） */
  boundaries: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
  variables: z
    .record(z.string().max(200))
    .refine((value) => Object.keys(value).length <= 30, { message: '自定义变量最多 30 个' })
    .optional(),
  behavior: behaviorSchema.optional(),
  fallbacks: fallbacksSchema.optional(),
  quoteTendency: z.enum(QUOTE_TENDENCIES).optional(),
} as const;

export const createPersonaSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    ...contentFields,
  })
  .strict();

export const updatePersonaSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    ...contentFields,
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个要修改的字段' });

export const personaIdSchema = z.string().trim().min(1).max(64);
export const instanceIdSchema = z.string().trim().min(1).max(64);
export const listPersonasQuerySchema = z
  .object({
    includeArchived: z.enum(['0', '1', 'true', 'false']).optional(),
  })
  .strict();

export type CreatePersonaInput = z.infer<typeof createPersonaSchema>;
export type UpdatePersonaInput = z.infer<typeof updatePersonaSchema>;

// ─────────────────────────── 出参 ───────────────────────────

/**
 * 对外的完整人设。
 *
 * 有 `publishedSnapshot` 但没有它的历史列表：这一版只做"当前态 + 最近一次发布快照"，
 * 多版本历史要配一张 `PersonaVersion` 表，那是 M4 之后的事（现在硬做等于假多版本）。
 */
export type PersonaPublicDTO = {
  id: string;
  instanceId: string;
  name: string;
  avatar: string | null;
  tagline: string | null;
  identity: Record<string, string>;
  promptBlocks: Array<Record<string, unknown>>;
  examples: Array<{ user?: string; assistant?: string }>;
  opening: Record<string, string>;
  boundaries: string[];
  variables: Record<string, string>;
  behavior: Record<string, unknown>;
  fallbacks: Record<string, unknown>;
  quoteTendency: string;
  version: number;
  status: string;
  publishedAt: string | null;
  archivedAt: string | null;
  /** 是不是这个实例当前生效的人设 */
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

/** 库里存的是字符串；坏掉就回落空结构，不让编辑页崩 */
function parseJson<T>(raw: string, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(raw);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

export type PersonaRowLike = {
  id: string;
  instanceId: string;
  name: string;
  avatar: string | null;
  tagline: string | null;
  identityJson: string;
  promptBlocksJson: string;
  examplesJson: string;
  openingJson: string;
  boundariesJson: string;
  variablesJson: string;
  behaviorJson: string;
  fallbacksJson: string;
  quoteTendency: string;
  version: number;
  status: string;
  publishedAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export function toPersonaDTO(row: PersonaRowLike, activePersonaId: string | null): PersonaPublicDTO {
  return {
    id: row.id,
    instanceId: row.instanceId,
    name: row.name,
    avatar: row.avatar,
    tagline: row.tagline,
    identity: parseJson<Record<string, string>>(row.identityJson, {}),
    promptBlocks: parseJson<Array<Record<string, unknown>>>(row.promptBlocksJson, []),
    examples: parseJson<Array<{ user?: string; assistant?: string }>>(row.examplesJson, []),
    opening: parseJson<Record<string, string>>(row.openingJson, {}),
    boundaries: parseJson<string[]>(row.boundariesJson, []),
    variables: parseJson<Record<string, string>>(row.variablesJson, {}),
    behavior: parseJson<Record<string, unknown>>(row.behaviorJson, {}),
    fallbacks: parseJson<Record<string, unknown>>(row.fallbacksJson, {}),
    quoteTendency: row.quoteTendency,
    version: row.version,
    status: row.status,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    active: activePersonaId === row.id,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 请求体里的对象 → 库里存的字符串。未提供（undefined）时返回 undefined，表示"别动这一列" */
export function serializeJsonField(value: unknown): string | undefined {
  return value === undefined ? undefined : JSON.stringify(value);
}

export function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.join('.') ?? '';
    throw new BadRequestError(where ? `${where}: ${issue?.message}` : '参数不合法');
  }
  return result.data;
}
