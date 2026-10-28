/**
 * 主动消息的心跳（M5-3 / D047）。
 *
 * 为什么是"每 10 分钟扫一次"而不是"每小时整点"：
 *   - 整点会让所有实例在同一分钟里一起动作，日志和风控信号都糊在一起；
 *   - 10 分钟的粒度足够让"刚好过了 48 小时"这件事在半小时内被发现，
 *     而真正的限频（每人每天 1 次 / 每实例每天 3 次 / 同一人 72 小时）由闸门保证，
 *     与扫描频率无关。
 *
 * **默认什么都不做**：没有实例打开开关时，`sweep` 连候选都不查（D047）。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { ProactiveService } from '../modules/proactive/proactive.service';
import { PROACTIVE_SERVICE } from '../modules/proactive/tokens';

@Injectable()
export class ProactiveWorker {
  private readonly logger = new Logger('ProactiveWorker');
  /** 上一轮还没跑完时跳过这一轮：扫一轮可能几十秒，叠起来只会互相打架 */
  private running = false;

  constructor(@Inject(PROACTIVE_SERVICE) private readonly service: ProactiveService) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const report = await this.service.sweep();
      // 只在"真的发了"或"出错了"时打日志：每 10 分钟一条"什么也没发生"会把日志淹掉
      if (report.sent > 0) {
        this.logger.log(
          `主动消息：发出 ${report.sent} 条（扫过 ${report.instances} 个实例，跳过 ${report.skipped} 个候选）`,
        );
      }
      for (const event of report.events.filter((item) => !item.ok)) {
        this.logger.warn(
          `主动消息未发出：实例 ${event.instanceId} 候选 ${event.peerId ?? '-'} 原因 ${event.reason}`,
        );
      }
    } catch (err) {
      // 定时任务不该因为一次异常就停止：Next tick 照跑
      this.logger.warn(`主动消息心跳失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }
}
