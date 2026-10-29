/**
 * 风控巡检心跳（M6-1 / D048）。
 *
 * 每 5 分钟一次（ARCHITECTURE 7.3 的节奏）：把"最近 24 小时发生了什么"算成健康分，
 * 该冷却就冷却、该只收不发就只收不发、该停就停。
 *
 * 为什么不是"实时"：`send_blocked` 发生时我们已经把它落成事件了，
 * 5 分钟的滞后完全够 —— 而每收一条消息都跑一遍巡检，等于给主链路加一次全表扫描。
 *
 * 日志只在"降级/停实例"时打：正常巡检每 5 分钟一条会把日志淹掉。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { RiskService } from '../modules/risk/risk.service';
import { RISK_SERVICE } from '../modules/risk/tokens';

@Injectable()
export class RiskWorker {
  private readonly logger = new Logger('RiskWorker');
  /** 上一轮没跑完就跳过这一轮（实例多时一轮可能几十秒） */
  private running = false;

  constructor(@Inject(RISK_SERVICE) private readonly service: RiskService) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const report = await this.service.sweep();
      if (report.degraded > 0 || report.stopped > 0) {
        this.logger.warn(
          `风控巡检：检查 ${report.inspected} 个实例，降级 ${report.degraded} 个（其中停用 ${report.stopped} 个）`,
        );
      }
    } catch (err) {
      // 巡检失败不能停掉定时器；下一轮继续
      this.logger.warn(`风控巡检异常：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }
}
