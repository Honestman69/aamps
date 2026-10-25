/**
 * 媒体模块的 Prisma 实现：只做"按 owner 取一把 Key"。
 */

import type { PrismaClient } from '@prisma/client';

import type { ITtsCredentialRepository, TtsCredential } from '../ports';

export class PrismaTtsCredentialRepository implements ITtsCredentialRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findForUser(ownerUserId: string, credentialId: string): Promise<TtsCredential | null> {
    const row = await this.prisma.credential.findFirst({
      // 归属过滤写在 where 里，不是查出来再判：漏掉这一步就等于跨用户拿 Key
      where: { id: credentialId, ownerUserId },
      select: {
        id: true,
        provider: true,
        baseUrl: true,
        authStyle: true,
        apiKeyEnc: true,
        enabled: true,
      },
    });
    if (!row || !row.enabled) {
      return null;
    }
    return {
      id: row.id,
      provider: row.provider,
      baseUrl: row.baseUrl,
      authStyle: row.authStyle,
      apiKeyEnc: row.apiKeyEnc,
    };
  }
}
