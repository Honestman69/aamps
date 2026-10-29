/**
 * 出站节流服务（M6-2 / D049）。
 *
 * 把"最近发了什么"读出来，交给纯函数判断"现在能不能发、要不要等一下"。
 * 判断逻辑全在 `throttle.ts`，这里只负责取数与兜底。
 *
 * ## 一条硬规矩：这里永不 throw
 *
 * 它跑在 `deliver` 之前。如果读库失败就抛，整条回复会掉进兜底话术 ——
 * 而"多发一条消息"的代价远小于"因为数不清发了几条就彻底不说话"。
 * 所以读不到就当"没超限"，让它正常说话。
 */

import type { OutboundRejectReason } from './throttle';
import {
  countConsecutive,
  countSimilar,
  decideOutbound,
  OUTBOUND_LIMITS,
} from './throttle';
import type { IOutboundRepository } from './ports';

export type ThrottleInput = {
  instanceId: string;
  sessionId: string;
  /** 即将发出的正文（相似内容判定用） */
  text: string;
  now: Date;
  /** 配置里的每日上限；`0` 或未传 = 用默认 800 */
  dailyCap?: number;
};

export type ThrottleResult =
  | { allow: true; waitMs: number }
  | { allow: false; reason: OutboundRejectReason };

/** 24 小时窗口最多看多少条出站（够判相似，不至于读整张表） */
const OUTBOUND_SCAN_LIMIT = 200;
/** 连续条数只需要看最近这些消息 */
const RECENT_SCAN_LIMIT = 10;

function startOfDay(now: Date): Date {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day;
}

export class OutboundGuardService {
  constructor(private readonly deps: { repo: IOutboundRepository }) {}

  async check(input: ThrottleInput): Promise<ThrottleResult> {
    try {
      const hourAgo = new Date(input.now.getTime() - 3600_000);
      const similarSince = new Date(
        input.now.getTime() - OUTBOUND_LIMITS.similarWindowHours * 3600_000,
      );

      const [outbound, recent, instanceToday] = await Promise.all([
        this.deps.repo.listOutbound(input.sessionId, similarSince, OUTBOUND_SCAN_LIMIT),
        this.deps.repo.listRecentMessages(input.sessionId, RECENT_SCAN_LIMIT),
        this.deps.repo.countOutboundForInstance(input.instanceId, startOfDay(input.now)),
      ]);

      const sessionLastHour = outbound.filter((row) => row.createdAt >= hourAgo).length;
      const decision = decideOutbound({
        now: input.now,
        dailyCap: input.dailyCap,
        recent: {
          sessionLastHour,
          instanceToday,
          consecutive: countConsecutive(recent),
          lastOutboundAt: outbound[0]?.createdAt ?? null,
          similarCount: countSimilar(outbound, input.text),
        },
      });
      return decision;
    } catch {
      // 见文件头：数不清就让它说话，不要因为节流层故障把人变成哑巴
      return { allow: true, waitMs: 0 };
    }
  }
}
