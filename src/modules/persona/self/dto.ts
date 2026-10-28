/**
 * 人格演化接口的入参校验。
 *
 * 两个都 `.strict()`：拼错字段名应当 400，而不是"看起来成功了但什么都没改"。
 */

import { z } from 'zod';

export const versionQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export const rollbackSchema = z
  .object({
    /** 目标版本号；0 = 最初的中性基线 */
    version: z.coerce.number().int().min(0),
  })
  .strict();
