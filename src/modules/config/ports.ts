/**
 * 配置载入端口。
 *
 * 这是**系统内部**读取（Pipeline 每次处理消息都要用），所以不带 userId：
 * 调用方拿到的是实例 id，而实例 id 只能来自已经过归属校验的上游（Session/Adapter）。
 * 这不是"无主查询"——真正的用户入口（Controller）仍然先校验归属再拿 id。
 */

import type { ConfigBundle } from './types';

/** 供写路径调用：配置改动后立刻失效，别让用户等 TTL */
export interface IConfigCacheInvalidator {
  invalidate(instanceId: string): number;
}

export interface IConfigSourceRepository {
  /** 一次取齐三层数据；实例不存在返回 null（上层转 404） */
  load(instanceId: string, sessionId?: string | null): Promise<ConfigBundle | null>;
}
