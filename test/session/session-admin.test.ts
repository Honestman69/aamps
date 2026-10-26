/**
 * 会话查看（D043）。
 *
 * 这组用例盯的是"看到的东西对不对"，以及三条边界：
 *   - 别人的实例 → 404（不是"空列表"，否则会让人以为还没聊过）
 *   - 别人的会话 → 404（跨用户读消息必须在这里断掉）
 *   - 坏数据（旧消息段 JSON 损坏、独白不是 JSON）→ 降级为空，而不是整页 500
 */

import type { ISessionAdminRepository, SessionSummaryRow } from '@/modules/session/ports';
import { mediaTypes, SessionAdminService, toThinkView } from '@/modules/session/session-admin.service';
import { describe, expect, it } from 'vitest';

const OWNER = 'user-1';

class FakeRepo implements ISessionAdminRepository {
  instanceOwned = true;
  sessionsInInstance: SessionSummaryRow[] = [];
  total = 0;
  session: { id: string; instanceId: string; kind: string; peerId: string; peerName: string | null } | null = {
    id: 'sess-1',
    instanceId: 'inst-1',
    kind: 'private',
    peerId: 'peer-1',
    peerName: '小林',
  };
  messages: Array<{
    id: string;
    role: string;
    senderName: string | null;
    content: string;
    createdAt: Date;
    segmentsJson: string;
    thinkJson: string | null;
    blocked: boolean;
    blockReason: string | null;
  }> = [];
  hasMore = false;
  lastListArgs: { userId: string; instanceId: string; limit: number } | null = null;
  lastMessageArgs: { sessionId: string; limit: number; before?: string } | null = null;

  async isInstanceOwned(userId: string, _instanceId: string): Promise<boolean> {
    return this.instanceOwned && userId === OWNER;
  }

  async listForUser(userId: string, instanceId: string, limit: number): Promise<SessionSummaryRow[]> {
    this.lastListArgs = { userId, instanceId, limit };
    return this.sessionsInInstance;
  }

  async countForUser(): Promise<number> {
    return this.total;
  }

  async findSessionForUser(userId: string) {
    return this.session && userId === OWNER ? this.session : null;
  }

  async listMessages(input: { sessionId: string; limit: number; before?: string }) {
    this.lastMessageArgs = input;
    return { rows: this.messages, hasMore: this.hasMore };
  }
}

function summary(overrides: Partial<SessionSummaryRow> = {}): SessionSummaryRow {
  return {
    id: 'sess-1',
    instanceId: 'inst-1',
    kind: 'private',
    peerId: 'peer-1',
    peerName: '小林',
    lastActiveAt: new Date('2026-10-26T12:00:00Z'),
    messageCount: 12,
    aiPaused: false,
    reviewMode: false,
    muted: false,
    lastMessage: {
      role: 'assistant',
      content: '晚安',
      senderName: '小雅',
      createdAt: new Date('2026-10-26T11:59:00Z'),
    },
    ...overrides,
  };
}

function setup(): { repo: FakeRepo; service: SessionAdminService } {
  const repo = new FakeRepo();
  return { repo, service: new SessionAdminService({ sessions: repo }) };
}

describe('会话列表', () => {
  it('别人的实例 → 404，而不是空列表', async () => {
    const { repo, service } = setup();
    repo.instanceOwned = false;

    await expect(service.listSessions({ userId: OWNER }, 'inst-x', { limit: 50 })).rejects.toMatchObject(
      { code: 'INSTANCE_NOT_FOUND', httpStatus: 404 },
    );
  });

  it('映射字段，长摘要截断到 80 字并标出省略号', async () => {
    const { repo, service } = setup();
    repo.sessionsInInstance = [
      summary({ lastMessage: { role: 'user', content: '啊'.repeat(200), senderName: '小林', createdAt: new Date() } }),
    ];
    repo.total = 3;

    const result = await service.listSessions({ userId: OWNER }, 'inst-1', { limit: 20 });

    expect(result.total).toBe(3);
    const [item] = result.items;
    expect(item?.messageCount).toBe(12);
    expect(item?.lastMessage?.content).toHaveLength(81); // 80 字 + 省略号
    expect(item?.lastMessage?.content.endsWith('…')).toBe(true);
    expect(repo.lastListArgs).toEqual({ userId: OWNER, instanceId: 'inst-1', limit: 20 });
  });

  it('没有消息的会话（刚建没聊起来）→ lastMessage 为 null，不报错', async () => {
    const { repo, service } = setup();
    repo.sessionsInInstance = [summary({ lastMessage: null, messageCount: 0 })];

    const result = await service.listSessions({ userId: OWNER }, 'inst-1', { limit: 20 });
    expect(result.items[0]?.lastMessage).toBeNull();
    expect(result.items[0]?.messageCount).toBe(0);
  });

  it('群聊标记原样带出（界面据此区分）', async () => {
    const { repo, service } = setup();
    repo.sessionsInInstance = [summary({ kind: 'group', peerName: '摸鱼群' })];
    const result = await service.listSessions({ userId: OWNER }, 'inst-1', { limit: 20 });
    expect(result.items[0]?.kind).toBe('group');
  });
});

describe('消息分页', () => {
  it('别人的会话 → 404（跨用户读消息在这里断掉）', async () => {
    const { service } = setup();
    await expect(
      service.listMessages({ userId: 'user-2' }, 'sess-1', { limit: 50 }),
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND', httpStatus: 404 });
  });

  it('before 原样传给仓储，hasMore 透传', async () => {
    const { repo, service } = setup();
    repo.hasMore = true;
    repo.messages = [
      {
        id: 'm1',
        role: 'user',
        senderName: '小林',
        content: '在吗',
        createdAt: new Date('2026-10-26T10:00:00Z'),
        segmentsJson: '[]',
        thinkJson: null,
        blocked: false,
        blockReason: null,
      },
    ];

    const page = await service.listMessages({ userId: OWNER }, 'sess-1', {
      limit: 20,
      before: 'm9',
    });

    expect(repo.lastMessageArgs).toEqual({ sessionId: 'sess-1', limit: 20, before: 'm9' });
    expect(page.hasMore).toBe(true);
    expect(page.items[0]?.id).toBe('m1');
  });

  it('坏的消息段 JSON 不让整页失败（media 降级为空）', async () => {
    const { repo, service } = setup();
    repo.messages = [
      {
        id: 'm1',
        role: 'user',
        senderName: null,
        content: '[图片]',
        createdAt: new Date(),
        segmentsJson: '{not json',
        thinkJson: 'also not json',
        blocked: false,
        blockReason: null,
      },
    ];

    const page = await service.listMessages({ userId: OWNER }, 'sess-1', { limit: 20 });
    expect(page.items[0]?.media).toEqual([]);
    expect(page.items[0]?.think).toBeNull();
  });
});

describe('mediaTypes：只报类型，不带 URL', () => {
  it('去重、忽略 text、保留图片与语音', () => {
    const json = JSON.stringify([
      { type: 'text', text: '看图' },
      { type: 'image', url: 'http://example.com/a.jpg' },
      { type: 'image', url: 'http://example.com/b.jpg' },
      { type: 'voice', url: 'file:///tmp/x.mp3' },
      { type: 'at', userId: '1' },
    ]);
    expect(mediaTypes(json)).toEqual(['image', 'voice', 'at']);
    // 关键：URL 一个都不许出现在返回里
    expect(JSON.stringify(mediaTypes(json))).not.toContain('example.com');
  });

  it('空串 / 非法 JSON / 非数组 → 空', () => {
    expect(mediaTypes('')).toEqual([]);
    expect(mediaTypes('oops')).toEqual([]);
    expect(mediaTypes('{"type":"image"}')).toEqual([]);
  });
});

describe('toThinkView：独白视图', () => {
  it('读得懂库里存的 camelCase', () => {
    const raw = JSON.stringify({
      wantToReply: 0.8,
      emotionShift: 0.2,
      intent: '他在抱怨加班',
      keyPoints: ['先共情'],
      tone: '心疼',
      lengthHint: '短',
    });
    expect(toThinkView(raw)).toEqual({
      wantToReply: 0.8,
      emotionShift: 0.2,
      intent: '他在抱怨加班',
      keyPoints: ['先共情'],
      tone: '心疼',
      lengthHint: '短',
    });
  });

  it('也认模型原始输出的 snake_case（历史数据）', () => {
    const raw = JSON.stringify({ want_to_reply: 0.3, emotion_shift: -0.1, intent: '敷衍', key_points: [], tone: '', length_hint: '' });
    const view = toThinkView(raw);
    expect(view?.wantToReply).toBe(0.3);
    expect(view?.emotionShift).toBe(-0.1);
    expect(view?.intent).toBe('敷衍');
  });

  it('一个字段都对不上 → null（不画空面板）', () => {
    expect(toThinkView('{}')).toBeNull();
    expect(toThinkView(null)).toBeNull();
    expect(toThinkView('not json')).toBeNull();
  });
});
