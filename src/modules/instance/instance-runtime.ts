/**
 * 正在运行的适配器实例（进程内单例）。
 *
 * 为什么不放数据库：连接是**进程的**状态，不是数据。
 * 库里只记一个 `status` 供后台展示，真实连接与否以这里为准（重启后库里会残留 online，
 * 所以启动时/查询时要能和运行时对齐 —— 见 InstanceService.reconcileStatus）。
 */

import type { IAdapter } from '@newjob/contracts';

export class InstanceRuntime {
  private readonly adapters = new Map<string, IAdapter>();

  set(instanceId: string, adapter: IAdapter): void {
    this.adapters.set(instanceId, adapter);
  }

  get(instanceId: string): IAdapter | null {
    return this.adapters.get(instanceId) ?? null;
  }

  remove(instanceId: string): void {
    this.adapters.delete(instanceId);
  }

  has(instanceId: string): boolean {
    return this.adapters.has(instanceId);
  }

  runningIds(): string[] {
    return [...this.adapters.keys()];
  }

  size(): number {
    return this.adapters.size;
  }

  /** 进程退出/用户锁定时要把连接全断掉，否则 token 还在内存里活着 */
  async closeAll(): Promise<void> {
    const adapters = [...this.adapters.values()];
    this.adapters.clear();
    await Promise.allSettled(adapters.map((adapter) => adapter.disconnect()));
  }
}
