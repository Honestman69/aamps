/**
 * 可复现的伪随机（ARCHITECTURE 6.4）。
 *
 * 为什么不用 `Math.random`：延迟与拆条都带随机，一旦线上出现"这条回复慢得离谱"或
 * "这句话被拆得很怪"，用 `Math.random` 就永远无法复现——只能靠猜。
 * 把种子绑到"哪条消息"上，同一个输入重放就是同一个结果。
 *
 * 实现用 mulberry32：32 位状态、一行代码、分布够用。这里不需要密码学随机
 * （**绝不能用它做任何安全用途**：token、盐、密钥一律走 `common/crypto`）。
 */

/** 字符串 → 32 位种子（FNV-1a） */
function hashSeed(seed: string): number {
  let hash = 2166136261 >>> 0;
  for (const char of seed) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash || 1;
}

/** 返回 [0, 1) 的确定性随机序列 */
export function seededRand(seed: string): () => number {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 消息级种子：同一个会话的同一条消息，重放结果一致 */
export function messageSeed(sessionKey: string, messageId: string): string {
  return `${sessionKey}#${messageId}`;
}
