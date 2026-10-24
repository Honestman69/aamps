/**
 * 配置服务：载入 + 解析 + 短 TTL 缓存。
 *
 * 为什么需要缓存：配置在**每条消息**的处理链路上都要读，而消息可能每秒好几条。
 * 直接查库的话，SQLite 单文件会被读操作挤住（写反而更慢）。
 *
 * 缓存的三条纪律：
 *   1. **TTL 短**（默认 30 秒）。配置改动要能在半分钟内生效，不做长期缓存。
 *   2. **写路径主动失效**（`invalidate`）。改实例 / 发布人设后立刻清，用户点保存后不该等 30 秒。
 *   3. 缓存 key 必须带 sessionId：会话级覆盖（临时换人设）与实例级不能混用。
 *
 * 注意：缓存的是**解析结果**，不是原始行。这样每次命中都不需要重新跑解析逻辑。
 */

import { AppError } from '@newjob/contracts';

import type { IConfigSourceRepository } from './ports';
import { resolveConfig } from './resolver';
import type { ResolvedConfig } from './types';

export const DEFAULT_CONFIG_TTL_MS = 30_000;

type CacheEntry = { value: ResolvedConfig; expiresAt: number };

export class ConfigService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly deps: {
      repo: IConfigSourceRepository;
      clock?: () => Date;
      ttlMs?: number;
    },
  ) {}

  private key(instanceId: string, sessionId?: string | null): string {
    return `${instanceId}::${sessionId ?? ''}`;
  }

  private now(): number {
    return (this.deps.clock?.() ?? new Date()).getTime();
  }

  async get(
    instanceId: string,
    options: { sessionId?: string | null; fresh?: boolean } = {},
  ): Promise<ResolvedConfig> {
    const { sessionId = null, fresh = false } = options;
    const cacheKey = this.key(instanceId, sessionId);

    if (!fresh) {
      const hit = this.cache.get(cacheKey);
      if (hit && hit.expiresAt > this.now()) {
        return hit.value;
      }
      if (hit) {
        this.cache.delete(cacheKey);
      }
    }

    const bundle = await this.deps.repo.load(instanceId, sessionId);
    if (!bundle) {
      throw new AppError('INSTANCE_NOT_FOUND', `实例不存在：${instanceId}`, 404);
    }

    const resolved = resolveConfig(bundle);
    const ttl = this.deps.ttlMs ?? DEFAULT_CONFIG_TTL_MS;
    // 过期时间用"现在 + ttl"，不用 Date.now()：测试里注入的时钟才能生效
    this.cache.set(cacheKey, { value: resolved, expiresAt: this.now() + ttl });
    return resolved;
  }

  /**
   * 清掉某实例的所有缓存（含所有会话级 key）。
   * 写路径（改实例配置、发布/重置人设、切换会话人设）必须调用它。
   */
  invalidate(instanceId: string): number {
    let removed = 0;
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`${instanceId}::`)) {
        this.cache.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** 测试与运维用：当前缓存条数（不含内容，避免误打印配置） */
  size(): number {
    return this.cache.size;
  }
}
