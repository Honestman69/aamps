/**
 * 凭据仓储的 Prisma 实现。
 *
 * 两条纪律：
 *   1. **每一条 where 都带 `ownerUserId`**，包括 update 与 delete。
 *      用 `update`/`delete` 而不是"先 findForUser 再按 id 写"：后者中间有空隙，
 *      而且一旦有人把第二段改成 `where: { id }`，越权访问就上线了。
 *   2. `select` 用白名单常量，**永不 `SELECT *`**。`apiKeyEnc` 不出现在任何 select 里，
 *      所以哪怕上层把整行透传给前端，也没有密文可漏。
 */

import { Prisma, type PrismaClient } from '@prisma/client';

import type {
  CredentialCreateInput,
  CredentialPublicRow,
  CredentialUpdatePatch,
  ICredentialRepository,
} from '../ports';

/**
 * 对外字段白名单。新增字段要显式加在这里，而不是改成"全选再删敏感项"。
 * 刻意不含：`apiKeyEnc`（密文）、`tenantId` / `ownerUserId`（归属信息不该出接口）、`catalogJson`（M2 再用）。
 */
const PUBLIC_SELECT = {
  id: true,
  provider: true,
  label: true,
  ownerLabel: true,
  baseUrl: true,
  authStyle: true,
  apiVersion: true,
  keyMasked: true,
  defaultModel: true,
  priority: true,
  enabled: true,
  disabledBy: true,
  lastCheckedAt: true,
  lastCheckOk: true,
  lastError: true,
  createdAt: true,
  updatedAt: true,
} as const;

export class PrismaCredentialRepository implements ICredentialRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createForUser(input: CredentialCreateInput): Promise<CredentialPublicRow> {
    return this.prisma.credential.create({
      data: {
        tenantId: input.tenantId,
        ownerUserId: input.ownerUserId,
        provider: input.provider,
        label: input.label,
        ownerLabel: input.ownerLabel ?? null,
        baseUrl: input.baseUrl ?? null,
        authStyle: input.authStyle ?? 'bearer',
        apiVersion: input.apiVersion ?? null,
        apiKeyEnc: input.apiKeyEnc,
        keyMasked: input.keyMasked,
        defaultModel: input.defaultModel ?? null,
        priority: input.priority ?? 100,
        enabled: input.enabled ?? true,
      },
      select: PUBLIC_SELECT,
    });
  }

  async listForUser(userId: string): Promise<CredentialPublicRow[]> {
    return this.prisma.credential.findMany({
      where: { ownerUserId: userId },
      select: PUBLIC_SELECT,
      // 同 provider 多 Key 时按 priority 升序用（配合轮换/降级），展示顺序与使用顺序一致
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async findForUser(userId: string, id: string): Promise<CredentialPublicRow | null> {
    return this.prisma.credential.findFirst({
      // id 之外再带 ownerUserId：即使拿到别人的 id，也查不出东西
      where: { id, ownerUserId: userId },
      select: PUBLIC_SELECT,
    });
  }

  async updateForUser(
    userId: string,
    id: string,
    patch: CredentialUpdatePatch,
  ): Promise<CredentialPublicRow | null> {
    if (Object.keys(patch).length === 0) {
      return this.findForUser(userId, id);
    }
    try {
      // 扩展现有 where：id 唯一键 + ownerUserId 过滤，一条 SQL 完成"只有本人能改"
      return await this.prisma.credential.update({
        where: { id, ownerUserId: userId },
        data: patch,
        select: PUBLIC_SELECT,
      });
    } catch (err) {
      // P2025 = 目标不存在（含"存在但不是你的"）。统一当作不存在，不暴露归属
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return null;
      }
      throw err;
    }
  }

  async deleteForUser(userId: string, id: string): Promise<boolean> {
    const { count } = await this.prisma.credential.deleteMany({
      where: { id, ownerUserId: userId },
    });
    return count > 0;
  }

  async countForUser(userId: string): Promise<number> {
    return this.prisma.credential.count({ where: { ownerUserId: userId } });
  }
}
