/**
 * 环境变量读取。
 *
 * 原则：**缺关键变量就启动失败**，不要给"看起来能跑"的默认值。
 * 尤其是 `SESSION_SECRET` —— 给它一个默认值等于把所有会话签名变成公开秘密。
 */

import { AppError } from '@newjob/contracts';

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new AppError('ENV_MISSING', `缺少必需的环境变量 ${name}`, 500);
  }
  return value.trim();
}

export function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * 会话签名密钥。
 * 只用于签 sessionId，**不参与任何数据加密**（与 D003 一致：这里没有 LLM 主密钥这种东西）。
 */
export function requireSessionSecret(): string {
  const secret = requireEnv('SESSION_SECRET');
  if (secret.length < 32) {
    throw new AppError('ENV_INVALID', 'SESSION_SECRET 至少 32 字符', 500);
  }
  if (isProduction() && /change-me|dev-only/i.test(secret)) {
    throw new AppError('ENV_INVALID', '生产环境不允许使用示例 SESSION_SECRET', 500);
  }
  return secret;
}
