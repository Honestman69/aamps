/**
 * 入参校验。用 zod 在 Controller 边界做，**Schema 即文档**。
 *
 * 注意：这里只校验形态，不校验业务规则（密码强度在 Service 里，避免两处规则漂移）。
 */

import { BadRequestError } from '@newjob/contracts';
import { z, type ZodType } from 'zod';

export const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});

export const unlockSchema = z.object({
  password: z.string().min(1).max(256),
});

export const changePasswordSchema = z.object({
  oldPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
});

export const resetPasswordSchema = z.object({
  newPassword: z.string().min(1).max(256),
  /** 二次确认：必须等于目标用户名，防止手滑点错人（SECURITY.md 5.1 路径 B） */
  confirmUsername: z.string().min(1).max(64),
});

/**
 * 用户名：登录入口，限制成"可打出来的固定字符集"。
 *
 * 不允许空格 / 中文 / 大小写混用（SQLite 的 `=` 对 ASCII 是大小写敏感的，
 * 而人的记忆不是）—— 建号时就拦住，比事后"为什么登不上"好查得多。
 */
const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9_.-]+$/, '只能用 3~64 位小写字母、数字、下划线、点或短横线');

const displayNameSchema = z.string().trim().max(64);

/** 密码强度不在这里校验：规则属业务，与改密/重置共用 `assertPasswordPolicy` */
export const createUserSchema = z
  .object({
    username: usernameSchema,
    displayName: displayNameSchema.nullable().optional(),
    password: z.string().min(1).max(256),
    /** 默认 user。建第二个 superadmin 是允许的：否则唯一管理员被锁死就没人能救 */
    role: z.enum(['user', 'superadmin']).optional(),
  })
  .strict();

export const updateUserSchema = z
  .object({
    /** null = 清空显示名（回落到用户名） */
    displayName: displayNameSchema.nullable().optional(),
    role: z.enum(['user', 'superadmin']).optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个要修改的字段' });

export const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export function parseOrThrow<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.join('.') ?? '';
    throw new BadRequestError(where ? `${where}: ${issue?.message}` : '参数不合法');
  }
  return result.data;
}
