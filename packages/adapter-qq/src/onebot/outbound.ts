/**
 * `OutboundAction` → OneBot API 调用参数。
 *
 * 只做"翻译"，不做决策：要不要拆条、要不要延迟、要不要拦截，都是出站管道的事。
 */

import type { OutboundAction, Segment } from '@newjob/contracts';

export type OneBotCall = {
  action: string;
  params: Record<string, unknown>;
};

function toOneBotSegment(segment: Segment): Record<string, unknown> | null {
  switch (segment.type) {
    case 'text':
      return { type: 'text', data: { text: segment.text } };
    case 'image':
      // OneBot 的 file 字段同时接受本地路径、URL 与 base64
      return { type: 'image', data: { file: segment.url } };
    case 'face':
      return { type: 'face', data: { id: segment.id } };
    case 'at':
      return { type: 'at', data: { qq: segment.userId } };
    case 'reply':
      return { type: 'reply', data: { id: segment.messageId } };
    case 'voice':
      return { type: 'record', data: { file: segment.url } };
    case 'file':
      return { type: 'file', data: { file: segment.url, name: segment.name } };
    case 'unknown':
      // 发不出去的东西直接丢掉，不要让整条消息因为一个卡片段失败
      return null;
    default:
      return null;
  }
}

export function toOneBotCall(action: OutboundAction): OneBotCall {
  if (action.kind === 'recall') {
    return { action: 'delete_msg', params: { message_id: action.messageId } };
  }

  const segments: Record<string, unknown>[] = [];
  // 引用回复必须是第一段，否则 QQ 侧不认
  if (action.replyToMessageId) {
    segments.push({ type: 'reply', data: { id: action.replyToMessageId } });
  }
  for (const segment of action.segments) {
    const mapped = toOneBotSegment(segment);
    if (mapped) {
      segments.push(mapped);
    }
  }

  const message = segments.length > 0 ? segments : [{ type: 'text', data: { text: '' } }];

  if (action.session.kind === 'group') {
    return {
      action: 'send_msg',
      params: { message_type: 'group', group_id: action.session.peerId, message },
    };
  }
  if (action.session.kind === 'private') {
    return {
      action: 'send_msg',
      params: { message_type: 'private', user_id: action.session.peerId, message },
    };
  }
  // 评论 / 弹幕 / 直播间不属于 QQ 的 OneBot 能力范围，早失败比默默发到错地方好
  throw new Error(`QQ(OneBot) 不支持会话类型：${action.session.kind}`);
}
