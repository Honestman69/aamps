/**
 * 平台能力契约。
 *
 * 为什么需要这一层：
 *   QQ 群、抖音评论、B站弹幕的差异不只是"协议不同"，而是**社交模型不同**。
 *   如果不在契约层声明，上层逻辑最后会写满 `if (platform === 'qq')`。
 *
 * 典型差异：
 *   - 抖音私信需要用户先说话才能回（48 小时窗口），不能主动发起
 *   - B站评论区回复是**公开**的，一条说错所有人可见；QQ 私聊只有一个人看到
 *   - 弹幕有严格字数上限和发送频率限制
 *   - 直播间的"消息"混着进场、礼物、关注等事件，不全是对话
 *
 * 新增平台时：实现一个 IAdapter，并声明它的 capabilities。上层读 capabilities 做决策，
 * 不读 platform 字符串。
 */

import type { Platform, SessionKind } from './message';

export interface PlatformCapabilities {
  /** 支持哪几种会话类型；上层据此决定是否启用某些管道 */
  sessionKinds: SessionKind[];

  /** 能否主动发起会话（抖音私信不能，必须先由用户发起） */
  canSendProactive: boolean;

  /** 是否受"用户先说话"的时间窗口限制 */
  inboundWindowHours?: number;

  /** 单条消息字数上限（弹幕通常很短） */
  maxTextLength: number;

  /** 回复是否公开可见。公开 = 内容审核必须更严格（评论区、弹幕） */
  publicReply: boolean;

  /** 群/公开场景下是否必须 @ 才响应 */
  requiresMentionInPublic: boolean;

  /** 富媒体能力 */
  media: {
    image: boolean;
    voice: boolean;
    video: boolean;
    file: boolean;
    /** 是否支持引用回复（评论区通常不支持） */
    quote: boolean;
    /** 是否支持撤回 */
    recall: boolean;
  };

  /** 平台侧的频率限制提示，用于初始化令牌桶；实际值仍需保守配置 */
  rateLimitHint: {
    perMinute?: number;
    perHour?: number;
    perDay?: number;
  };

  /** 该平台的主要风控形态，决定风控策略的侧重 */
  riskProfile: 'account_ban' | 'content_removal' | 'rate_limit' | 'mixed';
}

/**
 * 已知平台的默认能力表。
 * 注意：这是"声明"，不是"实现"。未实现的平台不会有 Adapter，声明只是让新增平台时知道要填什么。
 */
export const PLATFORM_CAPABILITIES: Record<Platform, PlatformCapabilities> = {
  qq: {
    sessionKinds: ['private', 'group'],
    canSendProactive: true,
    maxTextLength: 4500,
    publicReply: false,
    requiresMentionInPublic: true,
    media: { image: true, voice: true, video: false, file: true, quote: true, recall: true },
    rateLimitHint: { perMinute: 20, perHour: 240, perDay: 800 },
    riskProfile: 'account_ban',
  },
  douyin: {
    sessionKinds: ['private', 'comment', 'live'],
    canSendProactive: false,
    inboundWindowHours: 48,
    maxTextLength: 1000,
    publicReply: true,
    requiresMentionInPublic: false,
    media: { image: true, voice: false, video: false, file: false, quote: true, recall: false },
    rateLimitHint: { perMinute: 10, perHour: 100 },
    riskProfile: 'content_removal',
  },
  bilibili: {
    sessionKinds: ['private', 'comment', 'danmaku'],
    canSendProactive: false,
    maxTextLength: 200,
    publicReply: true,
    requiresMentionInPublic: false,
    media: { image: true, voice: false, video: false, file: false, quote: false, recall: false },
    rateLimitHint: { perMinute: 6, perHour: 60 },
    riskProfile: 'mixed',
  },
};
