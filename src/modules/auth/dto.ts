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
