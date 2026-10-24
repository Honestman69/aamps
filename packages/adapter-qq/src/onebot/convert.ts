/**
 * OneBot 原始事件 → 契约类型。
 *
 * 这是本包最重要的文件：**转换之后，原始结构就再也不往上传了**。
 * `InboundMessage.raw` 字段虽然存在（给排障用），这里刻意**不填**：
 * 一旦填上，下游总有人会去读 `msg.raw.post_type`，铁律当天就破了。
 */

import {
  segmentsToText,
  type InboundMessage,
  type PlatformEvent,
  type PlatformEventKind,
  type Segment,
  type SessionKey,
  type Sender,
} from '@newjob/contracts';
import { idToString, type OneBotEvent, type OneBotMessageEvent, type OneBotNoticeEvent, type OneBotSegment } from './protocol';

export type ConvertContext = {
  instanceId: string;
  /** 本实例的 QQ 号，用于判断是否被 @ */
  selfId: string;
};

function asMessageEvent(event: OneBotEvent): OneBotMessageEvent | null {
  if (event.post_type !== 'message') {
    return null;
  }
  const candidate = event as OneBotMessageEvent;
  if (candidate.message === undefined || candidate.message === null) {
    return null;
  }
  return candidate;
}

function toSegment(raw: OneBotSegment): Segment {
  const data = (raw.data ?? {}) as Record<string, unknown>;
  const text = (value: unknown): string => (typeof value === 'string' ? value : idToString(value));

  switch (raw.type) {
    case 'text':
      return { type: 'text', text: text(data.text) };
    case 'image':
      // url 优先；file 是 NapCat 的本地缓存名，部分部署只给 file
      return { type: 'image', url: text(data.url) || text(data.file) };
    case 'face':
      return { type: 'face', id: text(data.id) };
    case 'at':
      return { type: 'at', userId: text(data.qq) };
    case 'reply':
      return { type: 'reply', messageId: text(data.id) };
    case 'record':
      return { type: 'voice', url: text(data.url) || text(data.file) };
    case 'file':
      return { type: 'file', url: text(data.url) || text(data.file), name: text(data.name) || 'file' };
    default:
      // 平台特有段（礼物卡片、小程序…）：保留原样但不解析，业务层只会看到 unknown
      return { type: 'unknown', raw };
  }
}

function toSegments(message: string | OneBotSegment[]): Segment[] {
  // 字符串形态 = 旧部署没开 messagePostFormat=array。
  // **不解析 CQ 码**：CQ 码里可以塞任意参数，解析等于给自己开一个注入口。
  if (typeof message === 'string') {
    return message.length > 0 ? [{ type: 'text', text: message }] : [];
  }
  return message.filter((item) => item && typeof item.type === 'string').map(toSegment);
}

/** 只处理真正的"别人发给我的消息"；自己发出去的（message_sent）一律丢弃，否则会自问自答 */
export function toInboundMessage(event: OneBotEvent, ctx: ConvertContext): InboundMessage | null {
  const raw = asMessageEvent(event);
  if (!raw) {
    return null;
  }

  const senderId = idToString(raw.user_id);
  if (!senderId) {
    return null;
  }

  const session: SessionKey =
    raw.message_type === 'group'
      ? { kind: 'group', peerId: idToString(raw.group_id) }
      : { kind: 'private', peerId: senderId };

  if (!session.peerId) {
    return null;
  }

  const segments = toSegments(raw.message);
  const sender: Sender = {
    id: senderId,
    name: raw.sender?.card?.trim() || raw.sender?.nickname?.trim() || senderId,
    // 是否主人由主服务按 owner 配置判定，适配器不该知道谁是主人
    isOwner: false,
  };

  const replySegment = segments.find((segment) => segment.type === 'reply');
  const isMentioned =
    session.kind === 'private'
      ? true
      : segments.some((segment) => segment.type === 'at' && segment.userId === ctx.selfId);

  return {
    id: idToString(raw.message_id) || `local-${Date.now()}`,
    platform: 'qq',
    instanceId: ctx.instanceId,
    session,
    sender,
    segments,
    plainText: segmentsToText(segments),
    isMentioned,
    ...(replySegment && replySegment.type === 'reply'
      ? { replyToMessageId: replySegment.messageId }
      : {}),
    receivedAt: raw.time ? new Date(raw.time * 1000) : new Date(),
  };
}

const NOTICE_KINDS: Record<string, PlatformEventKind> = {
  group_increase: 'joined',
  group_decrease: 'left',
  friend_add: 'followed',
};

/**
 * 通知类事件（进群/退群/加好友）。
 * 只映射明确有语义的几种，其余返回 null —— 与其猜，不如先忽略，等真的需要再加。
 */
export function toPlatformEvent(event: OneBotEvent, ctx: ConvertContext): PlatformEvent | null {
  if (event.post_type !== 'notice') {
    return null;
  }
  const raw = event as OneBotNoticeEvent;
  const kind = NOTICE_KINDS[raw.notice_type];
  if (!kind) {
    return null;
  }
  const actorId = idToString(raw.user_id);
  const groupId = idToString(raw.group_id);
  const session: SessionKey = groupId
    ? { kind: 'group', peerId: groupId }
    : { kind: 'private', peerId: actorId };
  if (!session.peerId) {
    return null;
  }

  const actor: Sender | undefined = actorId
    ? { id: actorId, name: actorId, isOwner: false }
    : undefined;

  return {
    id: `${raw.notice_type}-${idToString(raw.time)}-${actorId || 'anon'}`,
    platform: 'qq',
    instanceId: ctx.instanceId,
    session,
    kind,
    ...(actor ? { actor } : {}),
    payload: raw.sub_type ? { subType: raw.sub_type } : undefined,
    receivedAt: raw.time ? new Date(raw.time * 1000) : new Date(),
  };
}
