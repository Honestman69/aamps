/**
 * OneBot 11 原始结构。**只允许出现在本包内**。
 *
 * 出包之前必须转成 `InboundMessage` / `PlatformEvent`（契约包里的类型）。
 * 主服务、管道、模型层都不认识这里的任何字段名。
 *
 * 字段一律留 `unknown`/可选：OneBot 是社区协议，不同实现（NapCat / Lagrange / go-cqhttp）
 * 会有出入，写得过窄会在真实环境里直接崩。
 */

export type OneBotSegment = { type: string; data?: Record<string, unknown> };

export type OneBotMessageEvent = {
  post_type: 'message' | 'message_sent';
  message_type: 'private' | 'group';
  sub_type?: string;
  message_id: number | string;
  user_id: number | string;
  group_id?: number | string;
  /** 开启 `messagePostFormat=array` 时是数组；某些部署仍是 CQ 码字符串 */
  message: string | OneBotSegment[];
  raw_message?: string;
  sender?: {
    user_id?: number | string;
    nickname?: string;
    card?: string;
    role?: string;
  };
  time?: number;
  self_id?: number | string;
};

export type OneBotNoticeEvent = {
  post_type: 'notice';
  notice_type: string;
  sub_type?: string;
  user_id?: number | string;
  group_id?: number | string;
  operator_id?: number | string;
  time?: number;
  self_id?: number | string;
};

export type OneBotMetaEvent = {
  post_type: 'meta_event';
  meta_event_type: 'lifecycle' | 'heartbeat';
  self_id?: number | string;
  interval?: number;
  time?: number;
};

/** 放进来的东西什么形状都可能，用判别字段自行收窄 */
export type OneBotEvent =
  | OneBotMessageEvent
  | OneBotNoticeEvent
  | OneBotMetaEvent
  | { post_type: string; [key: string]: unknown };

export type OneBotActionResponse = {
  status?: 'ok' | 'failed' | 'async';
  retcode?: number;
  data?: unknown;
  echo?: unknown;
};

/** 把 OneBot 的 number|string 统一成 string（QQ 号超过 2^53 的地区用字符串更保险） */
export function idToString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return '';
}
