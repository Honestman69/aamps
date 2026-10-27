/**
 * 会话查看（D043）：只读、owner 隔离、游标分页。
 *
 * 三个刻意的取舍：
 *
 * 1. **只读**。没有"删除消息 / 清空会话"的接口。消息记录是排查"机器人到底说了什么"的唯一证据，
 *    给它一个删除按钮，等于让最容易出问题的那一刻先把证据擦掉。真要清理，走数据库运维。
 *
 * 2. **不返回媒体 URL**。`segmentsJson` 里的图片/语音地址是协议端的临时链接（QQ 图床带 rkey，
 *    几小时到几天就 404），既不该在后台扩散，也不值得为它再开一条鉴权通道。
 *    界面只需要知道"这条消息里有图/有语音"，用 `media` 标签表示。
 *
 * 3. **条数是实时算的**。`Session.messageCount` 列没有任何写入方（永远是 0），
 *    用它显示"聊了多少条"会直接错。现算多一次 groupBy，但不会漂移。
 */

import { AppError } from '@newjob/contracts';

import type { ThinkResult } from '../mind/reflection/think';
import type {
  MessagePageDTO,
  SessionMessageDTO,
  SessionSummaryDTO,
} from './dto';
import type { ISessionAdminRepository } from './ports';

export type SessionActor = { userId: string };

export type SessionAdminDeps = {
  sessions: ISessionAdminRepository;
};

export class SessionAdminService {
  constructor(private readonly deps: SessionAdminDeps) {}

  async listSessions(
    actor: SessionActor,
    instanceId: string,
    options: { limit: number },
  ): Promise<{ items: SessionSummaryDTO[]; total: number }> {
    // 实例不存在 / 不属于这个人：404。不能回空数组 —— 那会让"点错实例"看起来像"还没聊过"
    if (!(await this.deps.sessions.isInstanceOwned(actor.userId, instanceId))) {
      throw instanceNotFound();
    }

    const [rows, total] = await Promise.all([
      this.deps.sessions.listForUser(actor.userId, instanceId, options.limit),
      this.deps.sessions.countForUser(actor.userId, instanceId),
    ]);

    return {
      total,
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind === 'group' ? 'group' : 'private',
        peerId: row.peerId,
        peerName: row.peerName,
        lastActiveAt: row.lastActiveAt.toISOString(),
        messageCount: row.messageCount,
        aiPaused: row.aiPaused,
        reviewMode: row.reviewMode,
        muted: row.muted,
        lastMessage: row.lastMessage
          ? {
              role: row.lastMessage.role,
              // 列表里只给一行摘要，长的截断：滚动列表里塞三百字没人会读
              content: truncate(row.lastMessage.content, 80),
              senderName: row.lastMessage.senderName,
              createdAt: row.lastMessage.createdAt.toISOString(),
            }
          : null,
      })),
    };
  }

  async listMessages(
    actor: SessionActor,
    sessionId: string,
    options: { limit: number; before?: string },
  ): Promise<MessagePageDTO> {
    // 先校验会话归属：跨用户 / 跨实例读消息必须在这里就断掉，
    // 而不是查完消息再"过滤一下"（过滤漏一处就串数据）
    const session = await this.deps.sessions.findSessionForUser(actor.userId, sessionId);
    if (!session) {
      throw new AppError('SESSION_NOT_FOUND', '会话不存在', 404);
    }

    const { rows, hasMore } = await this.deps.sessions.listMessages({
      sessionId: session.id,
      limit: options.limit,
      ...(options.before ? { before: options.before } : {}),
    });

    return {
      hasMore,
      items: rows.map(
        (row): SessionMessageDTO => ({
          id: row.id,
          role: row.role === 'assistant' || row.role === 'system' ? row.role : 'user',
          senderName: row.senderName,
          content: row.content,
          createdAt: row.createdAt.toISOString(),
          media: mediaTypes(row.segmentsJson),
          think: toThinkView(row.thinkJson),
          blocked: row.blocked,
          blockReason: row.blockReason,
        }),
      ),
    };
  }
}

function instanceNotFound(): AppError {
  return new AppError('INSTANCE_NOT_FOUND', '实例不存在', 404);
}

/** 列表摘要：按字符截断，并明确标出"被截断了"（用省略号，而不是悄悄少几个字） */
function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

/**
 * 从消息段里提取"这条消息有什么"。
 *
 * 只返回类型名（`image` / `voice` / `at` / `reply` …），**不带 URL 与内容**。
 * 解析失败一律当空数组：一段历史消息的坏 JSON 不该让整页 500。
 */
export function mediaTypes(segmentsJson: string): string[] {
  if (!segmentsJson) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(segmentsJson);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const types = new Set<string>();
    for (const segment of parsed) {
      if (!segment || typeof segment !== 'object') {
        continue;
      }
      const type = (segment as { type?: unknown }).type;
      if (typeof type === 'string' && type !== 'text') {
        types.add(type);
      }
    }
    return [...types].slice(0, 6);
  } catch {
    return [];
  }
}

/**
 * 内心独白视图（D036 落库的那份 JSON）。
 *
 * 兼容两种命名：库里存的是 `ThinkResult` 的 camelCase，而模型原始输出是 snake_case。
 * 两种都认，是因为"历史数据"与"模型输出"都可能被塞进这一列，而看记录的人不该为命名差异买单。
 */
export function toThinkView(raw: string | null): ThinkResult | null {
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const source = parsed as Record<string, unknown>;

  const intent = text(source.intent, 100);
  const tone = text(source.tone, 100);
  const lengthHint = text(source.lengthHint ?? source.length_hint, 60);
  const keyPoints = list(source.keyPoints ?? source.key_points);
  const wantToReply = number(source.wantToReply ?? source.want_to_reply, 0.5);
  const emotionShift = number(source.emotionShift ?? source.emotion_shift, 0);

  // 一个信号都没有就是坏数据，别在前端画一个空面板
  if (!intent && !tone && !lengthHint && keyPoints.length === 0) {
    return null;
  }
  return { wantToReply, emotionShift, intent, keyPoints, tone, lengthHint };
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function list(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((item) => text(item, 60))
        .filter((item) => item.length > 0)
        .slice(0, 5)
    : [];
}

function number(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
