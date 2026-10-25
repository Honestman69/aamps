/**
 * OneBot 事件转换测试。
 *
 * 这里守的是铁律：**原始结构不往上抛**。
 * 所以除了断言字段，还断言 `raw` 不存在 —— 一旦有人"为了方便"把它带上，
 * 下游迟早会去读 `post_type`。
 */

import { describe, expect, it } from 'vitest';

// 直接指向源码：包的公开入口只导出 factory，协议内部函数不该成为公共 API
import { toInboundMessage, toPlatformEvent } from '../../packages/adapter-qq/src/onebot/convert';

const CTX = { instanceId: 'inst-1', selfId: '10001' };

describe('OneBot → InboundMessage', () => {
  it('converts a private message and marks it as addressed to us', () => {
    const msg = toInboundMessage(
      {
        post_type: 'message',
        message_type: 'private',
        message_id: 42,
        user_id: 20002,
        message: [
          { type: 'text', data: { text: '在吗' } },
          { type: 'image', data: { url: 'https://example.com/a.png' } },
        ],
        sender: { user_id: 20002, nickname: '小明' },
        time: 1_726_000_000,
      },
      CTX,
    );

    expect(msg).not.toBeNull();
    expect(msg!.platform).toBe('qq');
    expect(msg!.instanceId).toBe('inst-1');
    expect(msg!.id).toBe('42');
    expect(msg!.session).toEqual({ kind: 'private', peerId: '20002' });
    expect(msg!.sender).toEqual({ id: '20002', name: '小明', isOwner: false });
    expect(msg!.plainText).toBe('在吗[图片]');
    // 私聊本身就是冲着机器人来的
    expect(msg!.isMentioned).toBe(true);
    expect(msg!.receivedAt.getTime()).toBe(1_726_000_000_000);
    expect('raw' in msg!).toBe(false);
  });

  it('detects @ in group messages and keeps the reply target', () => {
    const msg = toInboundMessage(
      {
        post_type: 'message',
        message_type: 'group',
        message_id: 'm-9',
        user_id: '20002',
        group_id: '88888',
        message: [
          { type: 'reply', data: { id: 'm-1' } },
          { type: 'at', data: { qq: '10001' } },
          { type: 'text', data: { text: ' 你好' } },
        ],
        sender: { user_id: '20002', nickname: '小明', card: '群昵称' },
      },
      CTX,
    );

    expect(msg!.session).toEqual({ kind: 'group', peerId: '88888' });
    expect(msg!.sender.name).toBe('群昵称');
    expect(msg!.isMentioned).toBe(true);
    expect(msg!.replyToMessageId).toBe('m-1');
  });

  it('does not treat a group message without @ as addressed to us', () => {
    const msg = toInboundMessage(
      {
        post_type: 'message',
        message_type: 'group',
        message_id: 'm-10',
        user_id: '20002',
        group_id: '88888',
        message: [{ type: 'text', data: { text: '随便聊聊' } }],
      },
      CTX,
    );

    expect(msg!.isMentioned).toBe(false);
  });

  it('drops our own outgoing messages (message_sent) to avoid self-reply loops', () => {
    const msg = toInboundMessage(
      {
        post_type: 'message_sent',
        message_type: 'private',
        message_id: 1,
        user_id: 10001,
        message: [{ type: 'text', data: { text: 'pong' } }],
      },
      CTX,
    );

    expect(msg).toBeNull();
  });

  it('keeps CQ-code strings as plain text instead of parsing them', () => {
    const msg = toInboundMessage(
      {
        post_type: 'message',
        message_type: 'private',
        message_id: 7,
        user_id: 20002,
        // 旧部署没开 messagePostFormat=array 时的形态。解析 CQ 码等于给自己开注入口
        message: '你好[CQ:face,id=1]',
      },
      CTX,
    );

    expect(msg!.segments).toHaveLength(1);
    expect(msg!.segments[0]).toEqual({ type: 'text', text: '你好[CQ:face,id=1]' });
  });

  it('maps mface with url to image（表情包要能进素材库）', () => {
    const msg = toInboundMessage(
      {
        post_type: 'message',
        message_type: 'private',
        message_id: 9,
        user_id: 20002,
        message: [
          { type: 'mface', data: { summary: '商城表情', url: 'https://gxh.vip.qq.com/x.png' } },
        ],
      },
      CTX,
    );

    expect(msg!.segments[0]).toEqual({ type: 'image', url: 'https://gxh.vip.qq.com/x.png' });
    expect(msg!.plainText).toBe('[图片]');
  });

  it('maps unknown segment types to unknown without leaking the payload as text', () => {
    const msg = toInboundMessage(
      {
        post_type: 'message',
        message_type: 'private',
        message_id: 8,
        user_id: 20002,
        message: [{ type: 'mface', data: { summary: '商城表情' } }],
      },
      CTX,
    );

    expect(msg!.segments[0]!.type).toBe('unknown');
    // 卡片段的内部数据结构不进纯文本视图，只留一个占位
    expect(msg!.plainText).toBe('[其他]');
  });
});

describe('OneBot notice → PlatformEvent', () => {
  it('maps group_increase to joined', () => {
    const event = toPlatformEvent(
      {
        post_type: 'notice',
        notice_type: 'group_increase',
        sub_type: 'approve',
        user_id: 30003,
        group_id: 88888,
        time: 1_726_000_100,
      },
      CTX,
    );

    expect(event?.kind).toBe('joined');
    expect(event?.session).toEqual({ kind: 'group', peerId: '88888' });
    expect(event?.actor?.id).toBe('30003');
  });

  it('ignores notice types it does not understand', () => {
    const event = toPlatformEvent(
      { post_type: 'notice', notice_type: 'group_card', user_id: 1, group_id: 2 },
      CTX,
    );
    expect(event).toBeNull();
  });
});
