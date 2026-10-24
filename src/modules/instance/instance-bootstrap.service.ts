/**
 * 启动钩子：恢复反向实例的监听。
 *
 * 为什么要单独一个 provider：`InstanceService` 是纯业务对象（构造参数手工注入，
 * 不依赖 Nest 生命周期），启动时机属于装配层的事，不该混进业务类。
 *
 * 为什么**不 await**：反向模式的 `connect()` 语义是"等到对端连上"，
 * 而 NapCat 可能正在重启、要 5 秒甚至更久才连回来。如果这里 await，
 * 整个服务启动会被实例连接拖住（几个实例就是几十秒）。
 * 监听本身是幂等的，晚几十秒变 online 不影响可用性。
 */

import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';

import type { InstanceService } from './instance.service';
import { INSTANCE_SERVICE } from './tokens';

@Injectable()
export class InstanceBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger('InstanceBootstrap');

  constructor(@Inject(INSTANCE_SERVICE) private readonly instances: InstanceService) {}

  onApplicationBootstrap(): void {
    void this.resume();
  }

  private async resume(): Promise<void> {
    try {
      const result = await this.instances.resumeResidentListeners();
      const total = result.started + result.failed + result.skipped;
      if (total > 0) {
        this.logger.log(
          `反向实例自监听：候选 ${total}，已监听 ${result.started}，` +
            `失败 ${result.failed}，跳过 ${result.skipped}`,
        );
      }
    } catch (err) {
      // 自监听失败不该拖垮整个服务：接口还能用，用户手动点连接仍可恢复
      this.logger.warn(`恢复反向实例失败：${(err as Error).message}`);
    }
  }
}
