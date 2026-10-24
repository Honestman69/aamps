/**
 * 故障原因 → 对端话术槽位（D028）。
 *
 * 背景：欠费**不再单独提醒 owner**。话术由 owner 自己配，机器人说出那句话，
 * owner 就知道是怎么回事。所以这里的映射必须稳定——它直接决定"用户看到哪句话"。
 *
 * 三个槽位（D026）：
 * - `shortOutage`：分钟级、会自愈 → 说一句"我这会儿有点事"是拟人
 * - `longOutage`：小时~天级（欠费、Key 失效）→ 也说，但频率必须严控
 * - `budgetLimit`：我方日/月限额 → 语义是"今天累了"，一天一次
 *
 * 注意：**话术是预存文本**，这里只做选择与频率判定，绝不调模型（D026）。
 */

import type { GatewayFailureReason } from '../model/gateway/gateway.service';
import type { FallbackSlot } from './fallbacks';

/**
 * 直接复用网关的原因枚举，**不在这里另立一份**。
 *
 * 两份定义一开始一样，加一个新原因时必然只改一处，然后某个分支静默落到错误槽位。
 * 复用之后，`SLOT_BY_REASON` 是 `Record<SpeakFailureReason, ...>`，
 * 网关新增原因时这里会**编译失败**，逼着人来决定它该说哪句话。
 */
export type SpeakFailureReason = GatewayFailureReason;

/**
 * 原因 → 槽位。
 *
 * - `balance` / `auth` 归 `longOutage`：都是"要等人去处理"的长时故障
 * - `no_candidate` 也归 `longOutage`：通常是没配 Key 或全被禁用，不是网络抖动
 * - `budget_exhausted` 单独一档：它是**我方**限额，与厂商欠费是两件事，
 *   话术分开才能让 owner 一眼分清"去充值"还是"改配置"
 */
const SLOT_BY_REASON: Record<SpeakFailureReason, FallbackSlot> = {
  balance: 'longOutage',
  auth: 'longOutage',
  no_candidate: 'longOutage',
  rate_limit: 'shortOutage',
  provider: 'shortOutage',
  network: 'shortOutage',
  budget_exhausted: 'budgetLimit',
};

export function faultToSlot(reason: SpeakFailureReason): FallbackSlot {
  return SLOT_BY_REASON[reason];
}

/**
 * 每个槽位允许的出声频率。
 *
 * 为什么必须限：**欠费会持续几小时到几天**。如果不限，"按话术回复"就变成
 * 每条消息都回一句"我这会儿有点事"——群里那是刷屏，私聊那是持续敷衍，
 * 比安静更伤关系。而 owner 只需要看到**一次**就知道出事了。
 */
export const FALLBACK_SPEAK_LIMITS: Record<
  FallbackSlot,
  { minIntervalMs: number; maxPerDay: number }
> = {
  // 抖动是分钟级：一小时内回复一次足够覆盖，全天不超过 3 次
  shortOutage: { minIntervalMs: 60 * 60 * 1000, maxPerDay: 3 },
  // 欠费/Key 失效可能持续几天：同一会话 6 小时内只回一次，全天 2 次
  longOutage: { minIntervalMs: 6 * 60 * 60 * 1000, maxPerDay: 2 },
  // "今天累了"本身就是一天一句的语义
  budgetLimit: { minIntervalMs: 12 * 60 * 60 * 1000, maxPerDay: 1 },
};

export type SpeakDecision = {
  speak: boolean;
  slot: FallbackSlot;
  /** 不说的原因，用于日志。**不要发给对端** */
  suppressedBy?: 'tooSoon' | 'dailyLimit' | 'noTemplate';
};

/**
 * 是否该在这个会话里出声。
 *
 * - `spokenAt`：该会话此前已发过的同槽位话术时间点（由上层记录，内存或事件表都行）
 * - `hasTemplate`：`resolveFallback` 是否取到了非 null 模板。用户配了 `null`（不说）就必须静默，
 *   这是用户的显式选择，不能被"默认值"覆盖
 *
 * 纯函数：时间从 `now` 传入，方便测试跨天、跨小时的行为。
 */
export function decideSpeak(
  slot: FallbackSlot,
  options: {
    spokenAt: readonly Date[];
    hasTemplate: boolean;
    now: Date;
  },
): SpeakDecision {
  const { spokenAt, hasTemplate, now } = options;
  if (!hasTemplate) {
    return { speak: false, slot, suppressedBy: 'noTemplate' };
  }

  const limits = FALLBACK_SPEAK_LIMITS[slot];
  const recent = spokenAt
    .filter((at) => at.getTime() <= now.getTime())
    .sort((a, b) => b.getTime() - a.getTime());

  // 先查日额度：一旦今天的额度用完，间隔已经没有意义，报 dailyLimit 更准确
  const dayStart = startOfLocalDay(now);
  const today = recent.filter((at) => at.getTime() >= dayStart.getTime()).length;
  if (today >= limits.maxPerDay) {
    return { speak: false, slot, suppressedBy: 'dailyLimit' };
  }

  const last = recent[0];
  if (last && now.getTime() - last.getTime() < limits.minIntervalMs) {
    return { speak: false, slot, suppressedBy: 'tooSoon' };
  }

  return { speak: true, slot };
}

/**
 * 本地零点的近似：按服务器时区算"一天"。
 *
 * 不用 UTC 的原因：用户感知的"今天"是本地今天。差 8 小时会让"全天 1 次"
 * 在凌晨提前重置，反而更容易刷屏。
 */
function startOfLocalDay(now: Date): Date {
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  return d;
}
