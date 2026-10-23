/**
 * 跨层消息契约。
 *
 * 铁律：业务代码只认这里的类型，任何地方都不允许直接出现某个平台的原始结构
 * （比如 OneBot 的 { post_type, message_type, raw_message }）。
 * 协议细节全部封在 src/modules/adapter/{platform} 里。
 *
 * 多平台预留说明见 docs/ARCHITECTURE.md 「平台扩展」一节。
 */

/**
 * 平台标识。
 * 新增平台时：在这里加一个字面量 → 实现对应 IAdapter → 在 PLATFORM_CAPABILITIES 补一行。
 * 三处之外不需要改动任何业务代码。
 */
export type Platform = 'qq' | 'douyin' | 'bilibili';

/**
 * 会话类型。不同平台只有其中一部分：
 *   QQ        → private / group
 *   抖音      → private（私信）/ comment（评论）/ live（直播间）
 *   B站       → private（私信）/ comment（动态评论）/ danmaku（弹幕）
 */
export type SessionKind = 'private' | 'group' | 'comment' | 'danmaku' | 'live';

export interface SessionKey {
  kind: SessionKind;
  /** 平台内的会话标识：私聊为对方用户 id，群聊为群号，评论为内容 id，直播间为房间号 */
  peerId: string;
}

export type Segment =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string }
  | { type: 'face'; id: string }
  | { type: 'at'; userId: string }
  | { type: 'reply'; messageId: string }
  | { type: 'voice'; url: string }
  | { type: 'file'; url: string; name: string }
  /** 平台特有段（礼物卡片、小程序卡片等）。业务层不解析，原样透传或忽略 */
  | { type: 'unknown'; raw: unknown };

export interface Sender {
  /** 平台内的用户 id（QQ 号 / 抖音 uid / B站 mid） */
  id: string;
  name: string;
  /** 是否为机器人主人账号，影响权限与语气 */
  isOwner: boolean;
}

export interface InboundMessage {
  /** 平台侧消息 id，用于去重与引用 */
  id: string;
  /** 冗余存放平台标识，避免每个消费方都去查 instance */
  platform: Platform;
  instanceId: string;
  session: SessionKey;
  sender: Sender;
  segments: Segment[];
  /** 纯文本视图，用于检索与规则匹配 */
  plainText: string;
  isMentioned: boolean;
  replyToMessageId?: string;
  receivedAt: Date;
  /** 原始事件，仅供排障；业务代码禁止读取 */
  raw?: unknown;
}

/**
 * 平台事件：不是"对话"，但会影响行为。
 * 例如抖音直播间的进场/礼物、B站的上舰/醒目留言、关注/取关。
 *
 * 与 InboundMessage 分开的原因：它们的处理语义完全不同——
 * 消息要走对话管道，事件走反应策略（欢迎、道谢、记录）。
 */
export type PlatformEventKind =
  | 'joined' // 进群 / 进直播间
  | 'left' // 退群 / 离开
  | 'followed' // 关注
  | 'unfollowed'
  | 'gift' // 送礼
  | 'liked' // 点赞
  | 'subscribed' // 上舰 / 开通会员
  | 'unknown';

export interface PlatformEvent {
  id: string;
  platform: Platform;
  instanceId: string;
  session: SessionKey;
  kind: PlatformEventKind;
  actor?: Sender;
  /** 事件附加信息，如礼物名、数量、金额 */
  payload?: Record<string, unknown>;
  receivedAt: Date;
  raw?: unknown;
}

export type OutboundAction =
  | {
      kind: 'send';
      session: SessionKey;
      segments: Segment[];
      replyToMessageId?: string;
    }
  | {
      kind: 'recall';
      session: SessionKey;
      messageId: string;
    };

/** 把消息段压成纯文本，供规则匹配与日志使用 */
export function segmentsToText(segments: Segment[]): string {
  return segments
    .map((s) => {
      switch (s.type) {
        case 'text':
          return s.text;
        case 'at':
          return `@${s.userId}`;
        case 'face':
          return '[表情]';
        case 'image':
          return '[图片]';
        case 'voice':
          return '[语音]';
        case 'file':
          return `[文件:${s.name}]`;
        case 'reply':
          return '';
        case 'unknown':
          return '[其他]';
        default:
          return '';
      }
    })
    .join('')
    .trim();
}

export function sessionId(key: SessionKey): string {
  return `${key.kind}:${key.peerId}`;
}
