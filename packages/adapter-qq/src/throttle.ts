/**
 * 令牌桶：**发送节流**的唯一实现（M1 第 5 项）。
 *
 * 为什么要自己写而不是装 `bottleneck`：
 *   - 只需要"匀速 + 允许突发到容量"，30 行的事；
 *   - 节流参数必须能按平台能力读（`capabilities.rateLimitHint`），现成库的配置面太重；
 *   - 出问题时需要一眼看懂，不是去读别人的调度器。
 *
 * 语义：桶里有容量上限的令牌，按 `refillPerSecond` 匀速回填。
 * `take()` 在没有令牌时**等待**，不丢消息也不排队无限增长。
 */

export type TokenBucketOptions = {
  /** 桶容量 = 允许的突发量 */
  capacity: number;
  /** 每秒回填多少令牌 */
  refillPerSecond: number;
  now?: () => number;
};

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;

  constructor(options: TokenBucketOptions) {
    if (!(options.capacity >= 1)) {
      throw new Error('令牌桶容量必须 ≥ 1');
    }
    if (!(options.refillPerSecond > 0)) {
      throw new Error('令牌回填速率必须 > 0');
    }
    this.capacity = options.capacity;
    this.refillPerSecond = options.refillPerSecond;
    this.now = options.now ?? (() => Date.now());
    this.tokens = options.capacity;
    this.lastRefill = this.now();
  }

  /** 立即取一个令牌；取不到返回 false，不等待 */
  tryTake(): boolean {
    this.refill();
    if (this.tokens < 1) {
      return false;
    }
    this.tokens -= 1;
    return true;
  }

  /** 取一个令牌，没有就等到有 */
  async take(): Promise<void> {
    while (!this.tryTake()) {
      const waitMs = this.msUntilNextToken();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(1, Math.ceil(waitMs)));
        timer.unref?.();
      });
    }
  }

  /** 当前可用令牌数（测试与看板用） */
  available(): number {
    this.refill();
    return this.tokens;
  }

  private refill(): void {
    const nowMs = this.now();
    const elapsedSec = (nowMs - this.lastRefill) / 1000;
    if (elapsedSec <= 0) {
      return;
    }
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSecond);
    this.lastRefill = nowMs;
  }

  private msUntilNextToken(): number {
    const missing = 1 - this.tokens;
    return (missing / this.refillPerSecond) * 1000;
  }
}

/** 从平台能力里的 perMinute 推出桶参数；没给就用保守默认 20/min、突发 3 */
export function bucketFromRateHint(hint: { perMinute?: number } | undefined): TokenBucket {
  const perMinute = hint?.perMinute && hint.perMinute > 0 ? hint.perMinute : 20;
  return new TokenBucket({
    capacity: Math.max(1, Math.min(5, Math.ceil(perMinute / 4))),
    refillPerSecond: perMinute / 60,
  });
}
