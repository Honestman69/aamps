/**
 * 协议端 token 的**摘要**：反向模式下握手只需要判断"对不对"，不需要明文。
 *
 * 为什么要有这个东西：
 *   明文 token 用 DEK 加密（零知识，D003/D005），而 DEK 只在用户登录后存在于内存。
 *   于是服务重启以后没人解锁 → 实例无法监听 → 云端只能靠人肉点一次"连接"。
 *   但握手校验本质上只是**一次比对**，用摘要就够了，不需要把明文捞回来。
 *
 * 算法：HMAC-SHA256(token, pepper)，pepper 由 `SESSION_SECRET` 派生（加域分隔前缀）。
 *   - 不用裸 SHA-256：token 是人填的，可能是弱口令，裸哈希会被彩虹表反查；
 *     加一个只有服务端知道的 pepper 就不会。
 *   - 不用 argon2：这段代码在 ws 的 `verifyClient` 里，每个连接一次，**同步且快**是硬要求；
 *     而且 token 通常是 32 位随机串，高熵，慢哈希在这里没有额外收益。
 *
 * 代价（必须知道）：
 *   - 换 `SESSION_SECRET` 会让所有摘要失效 → 需要在后台把 token 重新保存一次。
 *   - 摘要只回答"这个 token 对不对"，**不能**用来重建明文。
 */

import { createHmac } from 'node:crypto';

import { requireSessionSecret } from '../config/env';
import { constantTimeEqual } from './random';

/** 域分隔：同一个 secret 在不同用途下派生出的 key 不能互相通用 */
const DOMAIN = 'aamps:token-digest:v1';

function pepper(): string {
  return `${DOMAIN}:${requireSessionSecret()}`;
}

/** token → 摘要（hex）。同一 token 在同一 secret 下恒定 */
export function tokenDigest(token: string): string {
  return createHmac('sha256', pepper()).update(token, 'utf8').digest('hex');
}

/**
 * 校验对端带来的 token 是否匹配摘要。
 * 用 `crypto.timingSafeEqual` 比对，避免通过响应时间逐字节试探。
 */
export function verifyTokenDigest(provided: string, expectedDigest: string): boolean {
  if (!provided || !expectedDigest) {
    return false;
  }
  // 这里比较的是 HMAC 输出（定长 hex），不是明文 token
  const actual = Buffer.from(tokenDigest(provided), 'hex');
  const expected = Buffer.from(expectedDigest, 'hex');
  return constantTimeEqual(actual, expected);
}
