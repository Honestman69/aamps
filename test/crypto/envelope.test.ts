/**
 * 密码学底座的验收用例（STATUS.md 第 2 步）。
 *
 * 三类必须覆盖（CONVENTIONS.md「测试要求」）：
 *   1. 加解密往返
 *   2. 错误密码解不开
 *   3. 密文被篡改 → GCM 校验失败
 *
 * 另外补了格式约束与 AAD 绑定的用例：这两条是"双解密路径"和"密文互换"的防线，
 * 一旦被改坏，安全模型会静默失效，所以必须有断言兜着。
 */

import { describe, expect, it } from 'vitest';

import {
  ARGON2_PARAMS,
  DEK_BYTES,
  DEK_SEAL_PREFIX,
  DecryptionFailedError,
  LEGACY_SEAL_PREFIX,
  LegacyCiphertextError,
  SALT_BYTES,
  SealedFormatError,
  WRAP_SEAL_PREFIX,
  decryptWithDek,
  deriveKek,
  encryptWithDek,
  isDekSealed,
  isLegacySealed,
  randomDek,
  randomSalt,
  unwrapDek,
  wrapDek,
} from '@/common/crypto';

const PASSWORD = 'correct horse battery staple';
const WRONG_PASSWORD = 'correct horse battery stapl3';
const API_KEY = 'sk-live-0123456789abcdef0123456789abcdef';

/** 拆出 `xxx:v1:` 前缀与三段密文。按 `v1:` 切，不能只按第一个冒号切 */
function splitSealed(sealed: string): {
  prefix: string;
  iv: string;
  tag: string;
  cipher: string;
} {
  const marker = sealed.indexOf('v1:');
  const prefix = sealed.slice(0, marker + 3);
  const [iv, tag, cipher] = sealed.slice(prefix.length).split(':') as [string, string, string];
  return { prefix, iv, tag, cipher };
}

/** 把密文的 cipher 段翻转一个 bit，用来模拟数据库被改动 */
function tamperCipher(sealed: string): string {
  const { prefix, iv, tag, cipher } = splitSealed(sealed);
  const raw = Buffer.from(cipher, 'base64');
  raw[0] = (raw[0] ?? 0) ^ 0x01;
  return `${prefix}${iv}:${tag}:${raw.toString('base64')}`;
}

/** 只改认证标签 */
function tamperTag(sealed: string): string {
  const { prefix, iv, tag, cipher } = splitSealed(sealed);
  const raw = Buffer.from(tag, 'base64');
  raw[0] = (raw[0] ?? 0) ^ 0xff;
  return `${prefix}${iv}:${raw.toString('base64')}:${cipher}`;
}

describe('信封加密往返', () => {
  it('wrapDek / unwrapDek 与 encryptWithDek / decryptWithDek 能完整还原', async () => {
    const salt = randomSalt();
    const kek = await deriveKek(PASSWORD, salt);
    const dek = randomDek();

    const wrapped = wrapDek(dek, kek);
    const unwrapped = unwrapDek(wrapped, kek);
    expect(unwrapped.equals(dek)).toBe(true);
    expect(unwrapped.length).toBe(DEK_BYTES);

    const sealed = encryptWithDek(API_KEY, dek);
    expect(decryptWithDek(sealed, dek)).toBe(API_KEY);
  });

  it('密文格式严格为 dek:v1:<iv>:<tag>:<cipher>，且每段都是 base64', async () => {
    const dek = randomDek();
    const sealed = encryptWithDek(API_KEY, dek);

    expect(sealed.startsWith(DEK_SEAL_PREFIX)).toBe(true);
    const [iv, tag, cipher] = sealed.slice(DEK_SEAL_PREFIX.length).split(':') as [
      string,
      string,
      string,
    ];
    expect(Buffer.from(iv, 'base64').length).toBe(12);
    expect(Buffer.from(tag, 'base64').length).toBe(16);
    expect(Buffer.from(cipher, 'base64').length).toBeGreaterThan(0);
    expect(isDekSealed(sealed)).toBe(true);
  });

  it('每次加密的 IV 都不同（相同明文不产生相同密文）', () => {
    const dek = randomDek();
    const a = encryptWithDek(API_KEY, dek);
    const b = encryptWithDek(API_KEY, dek);
    expect(a).not.toBe(b);
    expect(decryptWithDek(a, dek)).toBe(API_KEY);
    expect(decryptWithDek(b, dek)).toBe(API_KEY);
  });

  it('同一密码 + 同一 salt 派生出同一把 KEK，换 salt 就不一样', async () => {
    const salt = randomSalt();
    const other = randomSalt();
    expect(salt.length).toBe(SALT_BYTES);

    const [k1, k2, k3] = await Promise.all([
      deriveKek(PASSWORD, salt),
      deriveKek(PASSWORD, salt),
      deriveKek(PASSWORD, other),
    ]);

    expect(k1.equals(k2)).toBe(true);
    expect(k1.equals(k3)).toBe(false);
  });
});

describe('Argon2 参数确实生效', () => {
  it('派生参数为 Argon2id / m=64MiB / t=3 / p=4 / len=32', async () => {
    // 直接解析 PHC 串反查参数。这条用例存在的意义：
    // @node-rs/argon2 的 Algorithm / Version 是 const enum，运行时是空对象，
    // 写成 Algorithm.Argon2id 会静默变成 undefined 并回落到库默认值（m=19MiB, t=2），
    // 安全性被悄悄降级但测试全绿——所以必须断言参数真的进去了。
    const { hash, parseOptions } = await import('@node-rs/argon2');
    const phc = await hash(PASSWORD, { ...ARGON2_PARAMS, salt: randomSalt() });
    const parsed = parseOptions(phc);

    expect(parsed.algorithm).toBe(2); // Argon2id
    expect(parsed.memoryCost).toBe(65536);
    expect(parsed.timeCost).toBe(3);
    expect(parsed.parallelism).toBe(4);
    expect(parsed.outputLen).toBe(32);
  });
});

describe('错误密码', () => {
  it('错误密码派生出的 KEK 解不开 wrappedDek', async () => {
    const salt = randomSalt();
    const correctKek = await deriveKek(PASSWORD, salt);
    const wrongKek = await deriveKek(WRONG_PASSWORD, salt);

    const wrapped = wrapDek(randomDek(), correctKek);

    // 错误信息里不允许出现任何密文片段（错误会被记日志、也可能被前端展示）
    let message = '';
    try {
      unwrapDek(wrapped, wrongKek);
    } catch (err) {
      expect(err).toBeInstanceOf(DecryptionFailedError);
      message = (err as Error).message;
    }
    expect(message).toMatch(/解密失败/);
    expect(message).not.toContain(wrapped);
  });

  it('用别人的 DEK 解不开这条 Key', async () => {
    const dek = randomDek();
    const anotherDek = randomDek();
    const sealed = encryptWithDek(API_KEY, dek);

    expect(() => decryptWithDek(sealed, anotherDek)).toThrow(DecryptionFailedError);
  });
});

describe('密文篡改', () => {
  it('改动 cipher 段触发 GCM 校验失败', () => {
    const dek = randomDek();
    const sealed = encryptWithDek(API_KEY, dek);

    expect(() => decryptWithDek(tamperCipher(sealed), dek)).toThrow(DecryptionFailedError);
  });

  it('改动认证标签触发 GCM 校验失败', () => {
    const dek = randomDek();
    const sealed = encryptWithDek(API_KEY, dek);

    expect(() => decryptWithDek(tamperTag(sealed), dek)).toThrow(DecryptionFailedError);
  });

  it('改动的 wrappedDek 解不出 DEK', async () => {
    const kek = await deriveKek(PASSWORD, randomSalt());
    const wrapped = wrapDek(randomDek(), kek);

    expect(() => unwrapDek(tamperCipher(wrapped), kek)).toThrow(DecryptionFailedError);
  });
});

describe('格式与 AAD 约束', () => {
  it('缺少前缀、分段数不对一律拒绝', () => {
    const dek = randomDek();
    expect(() => decryptWithDek('not-a-ciphertext', dek)).toThrow(SealedFormatError);
    expect(() => decryptWithDek(`${DEK_SEAL_PREFIX}onlyone`, dek)).toThrow(SealedFormatError);
  });

  it('旧格式 enc:v1: 被识别为必须迁移，而不是可解密', async () => {
    const kek = await deriveKek(PASSWORD, randomSalt());
    const legacy = `${LEGACY_SEAL_PREFIX}AAAA:BBBB:CCCC`;

    expect(isLegacySealed(legacy)).toBe(true);
    expect(isDekSealed(legacy)).toBe(false);
    expect(() => unwrapDek(legacy, kek)).toThrow(LegacyCiphertextError);
  });

  it('wrap 密文不能被当成 dek 密文解开（前缀进 AAD）', async () => {
    const kek = await deriveKek(PASSWORD, randomSalt());
    const dek = randomDek();
    const wrapped = wrapDek(dek, kek);

    expect(wrapped.startsWith(WRAP_SEAL_PREFIX)).toBe(true);
    const forged = DEK_SEAL_PREFIX + wrapped.slice(WRAP_SEAL_PREFIX.length);
    expect(() => decryptWithDek(forged, dek)).toThrow(DecryptionFailedError);
  });
});
