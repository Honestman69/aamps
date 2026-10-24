/**
 * 会话与消息持久化的 Prisma 实现。
 */

import type { PrismaClient } from '@prisma/client';

import { segmentsToText, type InboundMessage } from '@newjob/contracts';

import type { ISessionRepository, SessionRecord, StoredMessage } from '../persistence';

export class PrismaSessionRepository implements ISessionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async ensureSession(input: {
    instanceId: string;
    kind: string;
    peerId: string;
    peerName?: string | null;
  }): Promise<SessionRecord> {
    const session = await this.prisma.session.upsert({
      where: {
        instanceId_kind_peerId: {
          instanceId: input.instanceId,
          kind: input.kind,
          peerId: input.peerId,
        },
      },
      create: {
        instanceId: input.instanceId,
        kind: input.kind,
        peerId: input.peerId,
        peerName: input.peerName ?? null,
      },
      // 只更新名字与活跃时间：不碰 aiPaused / muted 等运行态
      update: {
        peerName: input.peerName ?? undefined,
        lastActiveAt: new Date(),
      },
    });

    return {
      id: session.id,
      instanceId: session.instanceId,
      kind: session.kind,
      peerId: session.peerId,
      peerName: session.peerName,
    };
  }

  async saveInbound(input: {
    sessionId: string;
    message: InboundMessage;
  }): Promise<StoredMessage> {
    const row = await this.prisma.message.create({
      data: {
        sessionId: input.sessionId,
        role: 'user',
        senderId: input.message.sender.id,
        senderName: input.message.sender.name,
        content: input.message.plainText || segmentsToText(input.message.segments),
        segmentsJson: JSON.stringify(input.message.segments),
      },
    });

    return {
      id: row.id,
      sessionId: row.sessionId,
      role: 'user',
      senderId: row.senderId,
      content: row.content,
      createdAt: row.createdAt,
    };
  }

  async saveOutbound(input: {
    sessionId: string;
    content: string;
    senderId: string | null;
    replyToMessageId?: string | null;
  }): Promise<StoredMessage> {
    const row = await this.prisma.message.create({
      data: {
        sessionId: input.sessionId,
        role: 'assistant',
        senderId: input.senderId,
        content: input.content,
        // 引用关系存进 segmentsJson 的 reply 段，与入站口径一致
        segmentsJson: input.replyToMessageId
          ? JSON.stringify([{ type: 'reply', messageId: input.replyToMessageId }])
          : '[]',
      },
    });

    return {
      id: row.id,
      sessionId: row.sessionId,
      role: 'assistant',
      senderId: row.senderId,
      content: row.content,
      createdAt: row.createdAt,
    };
  }
}
