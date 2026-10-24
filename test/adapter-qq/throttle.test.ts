/**
 * 令牌桶测试。时间靠注入的 `now()` 控制，不靠 sleep —— 不然测试要么慢要么飘。
 */

import { describe, expect, it } from 'vitest';

import { TokenBucket, bucketFromRateHint } from '../../packages/adapter-qq/src/throttle';

function fakeClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('TokenBucket', () => {
  it('allows a burst up to capacity, then refuses', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1, now: clock.now });

    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
  });

  it('refills at the configured rate', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 2, now: clock.now });

    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);

    clock.advance(500); // 2/s × 0.5s = 1 个
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
  });

  it('never exceeds capacity even after a long idle time', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 10, now: clock.now });

    bucket.tryTake();
    clock.advance(60_000);
    expect(bucket.available()).toBe(2);
  });

  it('rejects nonsense configuration instead of silently degrading', () => {
    expect(() => new TokenBucket({ capacity: 0, refillPerSecond: 1 })).toThrow();
    expect(() => new TokenBucket({ capacity: 1, refillPerSecond: 0 })).toThrow();
  });

  it('derives a conservative bucket from the platform rate hint', () => {
    const bucket = bucketFromRateHint({ perMinute: 20 });
    // 20/min → 每 3 秒一个，突发不超过 5
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.available()).toBeLessThanOrEqual(5);
  });
});
