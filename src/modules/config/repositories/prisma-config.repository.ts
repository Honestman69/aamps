import type { PrismaClient } from '@prisma/client';

import type { IConfigSourceRepository } from '../ports';
import type { ConfigBundle } from '../types';

/**
 * 一次查询取齐三层（实例 + 人设 + 会话），不产生 1+N。
 *
 * 只 select 配置需要的列：配置读取在消息主链路上，每多读一个用不到的列都是浪费。
 */
export class PrismaConfigSourceRepository implements IConfigSourceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async load(instanceId: string, sessionId?: string | null): Promise<ConfigBundle | null> {
    const instance = await this.prisma.botInstance.findUnique({
      where: { id: instanceId },
      select: {
        credentialId: true,
        modelMain: true,
        modelCheap: true,
        modelFallback: true,
        modelTemperature: true,
        rateLimitPerMin: true,
        dailyMsgCap: true,
        nightQuiet: true,
        activePersonaId: true,
      },
    });
    if (!instance) {
      return null;
    }

    const persona = instance.activePersonaId
      ? await this.prisma.persona.findFirst({
          where: { id: instance.activePersonaId },
          select: { id: true, behaviorJson: true },
        })
      : null;

    const session = sessionId
      ? await this.prisma.session.findFirst({
          // 必须带 instanceId：防止拿到别的实例的会话 id 混进配置
          where: { id: sessionId, instanceId },
          select: { id: true, personaId: true, aiPaused: true, reviewMode: true, muted: true },
        })
      : null;

    return { instance, persona, session };
  }
}
