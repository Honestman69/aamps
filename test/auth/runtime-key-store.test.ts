/**
 * RuntimeKeyStore：DEK 只能活在内存里，且不能被"顺手打印"泄漏出去。
 */

import { KeyLockedError } from '@newjob/contracts';
import { describe, expect, it } from 'vitest';

import { DEK_BYTES, randomDek } from '@/common/crypto';
import { RuntimeKeyStore } from '@/modules/auth';

function controlledClock(start = new Date('2026-10-23T00:00:00Z')) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe('RuntimeKeyStore', () => {
  it('存入后能取回同一把 DEK，且长度合法', () => {
    const store = new RuntimeKeyStore();
    const dek = randomDek();
    store.set('s1', 'u1', dek);

    const got = store.get('s1');
    expect(got.length).toBe(DEK_BYTES);
    expect(got.equals(dek)).toBe(true);
  });

  it('存的是副本：调用方擦掉自己手里的 buffer 不影响密钥库', () => {
    const store = new RuntimeKeyStore();
    const dek = randomDek();
    const snapshot = Buffer.from(dek);
    store.set('s1', 'u1', dek);

    dek.fill(0); // 模拟 unlock 流程 finally 里的 wipe

    expect(store.get('s1').equals(snapshot)).toBe(true);
    expect(store.get('s1').every((byte) => byte === 0)).toBe(false);
  });

  it('未解锁时取用抛 KeyLockedError，不返回 null 也不降级', () => {
    const store = new RuntimeKeyStore();
    expect(() => store.get('nope')).toThrow(KeyLockedError);
    expect(store.isUnlocked('nope')).toBe(false);
  });

  it('过期后视为未解锁，并且顺带清理条目', () => {
    const clock = controlledClock();
    const store = new RuntimeKeyStore(clock.now);
    store.set('s1', 'u1', randomDek(), 1000);

    expect(store.isUnlocked('s1')).toBe(true);
    clock.advance(1001);

    expect(store.isUnlocked('s1')).toBe(false);
    expect(() => store.get('s1')).toThrow(KeyLockedError);
    expect(store.size()).toBe(0);
  });

  it('clearForUser 只清目标用户的会话，返回清掉的条数', () => {
    const store = new RuntimeKeyStore();
    store.set('s1', 'u1', randomDek());
    store.set('s2', 'u1', randomDek());
    store.set('s3', 'u2', randomDek());

    expect(store.clearForUser('u1')).toBe(2);
    expect(store.isUnlocked('s1')).toBe(false);
    expect(store.isUnlocked('s2')).toBe(false);
    expect(store.isUnlocked('s3')).toBe(true);
  });

  it('JSON.stringify 不会泄漏 DEK（只会输出条目数）', () => {
    const store = new RuntimeKeyStore();
    const dek = randomDek();
    store.set('s1', 'u1', dek);

    const dumped = JSON.stringify(store);
    expect(dumped).toBe('{"unlockedSessions":1}');
    expect(dumped).not.toContain(dek.toString('base64').slice(0, 8));
    expect(dumped).not.toContain(dek.toString('hex').slice(0, 8));
  });

  it('拒绝非法 DEK 长度，避免把半个密钥放进库', () => {
    const store = new RuntimeKeyStore();
    expect(() => store.set('s1', 'u1', Buffer.alloc(16))).toThrow(/32 字节/);
  });
});
