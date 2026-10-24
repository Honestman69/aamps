/**
 * 适配器日志。适配器包只拿到 `AdapterDeps['logger']` 这个小接口，
 * 由主服务决定落到哪里（现在是 pino，以后换什么都行）。
 *
 * 脱敏策略（白名单）：适配器可以传任意结构化字段，但这里**只放行**一组字段名。
 * 密钥、token、完整 QQ 号不在白名单里，所以哪怕适配器顺手把 config 整个打出来，
 * 也不会进日志。
 */

import pino from 'pino';

import type { AdapterDeps } from '@newjob/contracts';

const LOGGER_ALLOWLIST = new Set([
  'event',
  'instanceId',
  'status',
  'attempt',
  'delayMs',
  'reason',
  'code',
  'messageId',
  'sessionKind',
  'latencyMs',
  'action',
]);

const root = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: undefined,
});

function scrub(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (LOGGER_ALLOWLIST.has(key)) {
      out[key] = value;
    }
  }
  return out;
}

export function createAdapterLogger(instanceId: string): AdapterDeps['logger'] {
  const logger = root.child({ instanceId });
  return {
    debug: (fields, msg) => logger.debug(scrub(fields), msg),
    info: (fields, msg) => logger.info(scrub(fields), msg),
    warn: (fields, msg) => logger.warn(scrub(fields), msg),
    error: (fields, msg) => logger.error(scrub(fields), msg),
  };
}
