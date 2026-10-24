/**
 * token 摘要的单元测试。
 *
 * 这里断言的是安全属性，不是实现细节：
 *   1. 单向：从摘要推不回 token（只验证长度与格式，不假装能测"不可逆"）
 *   2. 绑定服务端 secret：换 secret 后旧摘要必须失效，否则"换密钥"这件事会静默失效
 *   3. 校验对错要准：错一字符、空值、大小写都必须拒
 */

import { afterEach, describe, expect, it } from 'vitest';

import { tokenDigest, verifyTokenDigest } from '@/common/crypto/token-digest';

const original = process.env.SESSION_SECRET;

afterEach(() => {
  process.env.SESSION_SECRET = original;
});

describe('tokenDigest', () => {
  it('is stable for the same token and secret', () => {
    expect(tokenDigest('napcat-token')).toBe(tokenDigest('napcat-token'));
  });

  it('differs for different tokens', () => {
    expect(tokenDigest('token-a')).not.toBe(tokenDigest('token-b'));
  });

  it('produces a sha256 hex digest (no plaintext leaks through)', () => {
    const digest = tokenDigest('napcat-token');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain('napcat');
  });

  it('is bound to SESSION_SECRET: rotating the secret invalidates old digests', () => {
    const before = tokenDigest('napcat-token');
    process.env.SESSION_SECRET = 'rotated-session-secret-0123456789abcdef';
    const after = tokenDigest('napcat-token');

    expect(after).not.toBe(before);
    // 这正是文档里要写明的代价：换 secret 后必须重新保存一次 token
    expect(verifyTokenDigest('napcat-token', before)).toBe(false);
  });
});

describe('verifyTokenDigest', () => {
  it('accepts the matching token', () => {
    expect(verifyTokenDigest('napcat-token', tokenDigest('napcat-token'))).toBe(true);
  });

  it('rejects a wrong token, including one-character-off', () => {
    const digest = tokenDigest('napcat-token');
    expect(verifyTokenDigest('napcat-tokeN', digest)).toBe(false);
    expect(verifyTokenDigest('napcat-token ', digest)).toBe(false);
    expect(verifyTokenDigest('', digest)).toBe(false);
  });

  it('rejects when the stored digest is empty', () => {
    // 没有摘要等于没有校验手段，必须拒绝而不是"放行"
    expect(verifyTokenDigest('napcat-token', '')).toBe(false);
  });
});
