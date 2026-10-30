/**
 * 约束词接口的入参校验（D051）。
 *
 * 三个刻意的限制：
 *   1. `pattern` 上限 64 字：约束词是"片段"，写成一段话说明该用别的办法（软禁区/人设）。
 *   2. **不接受正则**：这里只校验它是普通文本，没有任何"正则开关"（见 `match.ts`）。
 *   3. `.strict()`：拼错字段名要 400，而不是"看起来保存成功但什么都没改"。
 */

import { AppError } from '@newjob/contracts';
import { z } from 'zod';

import { RULE_KINDS } from './match';

export const ruleKindSchema = z.enum(RULE_KINDS as unknown as [string, ...string[]]);

export const createRuleSchema = z
  .object({
    kind: ruleKindSchema,
    pattern: z.string().trim().min(1).max(64),
    note: z.string().trim().max(100).nullish(),
  })
  .strict();

export const updateRuleSchema = z
  .object({
    pattern: z.string().trim().min(1).max(64).optional(),
    note: z.string().trim().max(100).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const ruleIdSchema = z.string().trim().min(1).max(64);
export const ruleInstanceIdSchema = z.string().trim().min(1).max(64);

/** 与前端共用的返回形状 */
export type RuleDTO = {
  id: string;
  instanceId: string;
  kind: string;
  pattern: string;
  note: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export function toRuleDTO(row: {
  id: string;
  instanceId: string;
  kind: string;
  pattern: string;
  note: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}): RuleDTO {
  return {
    id: row.id,
    instanceId: row.instanceId,
    kind: row.kind,
    pattern: row.pattern,
    note: row.note,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new AppError('BAD_REQUEST', first ? `${first.path.join('.')}: ${first.message}` : '参数不合法', 400);
  }
  return parsed.data;
}
