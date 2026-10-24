/**
 * 实例仓储的 Prisma 实现。
 *
 * 与凭据仓储同构的三条纪律：
 *   1. `where` 恒带 `ownerUserId`（update 用扩展 where 一条 SQL 完成）；
 *   2. `select` 白名单，**密文只在 `findForConnect` 里出现**；
 *   3. `hasAccessToken` 是派生出来的布尔，不是密文本身。
 */

import { Prisma, type PrismaClient } from '@prisma/client';

import type {
  IInstanceRepository,
  InstanceConnectConfig,
  InstanceCreateInput,
  InstancePublicRow,
  InstanceUpdatePatch,
} from '../ports';

/**
 * 展示字段白名单。注意**不含** `accessTokenEnc`：
 * 这个 select 用于所有返回给接口的查询，密文没有机会混进去。
 */
const PUBLIC_SELECT = {
  id: true,
  name: true,
  platform: true,
  accountId: true,
  adapterType: true,
  adapterMode: true,
  endpoint: true,
  enabled: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** 连接用的最小字段集，含密文 */
const CONNECT_SELECT = {
  id: true,
  platform: true,
  adapterType: true,
  adapterMode: true,
  accountId: true,
  endpoint: true,
  accessTokenEnc: true,
  enabled: true,
} as const;

export class PrismaInstanceRepository implements IInstanceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createForUser(input: InstanceCreateInput): Promise<InstancePublicRow> {
    const created = await this.prisma.botInstance.create({
      data: {
        tenantId: input.tenantId,
        ownerUserId: input.ownerUserId,
        name: input.name,
        platform: input.platform,
        accountId: input.accountId,
        adapterType: input.adapterType,
        endpoint: input.endpoint ?? null,
        accessTokenEnc: input.accessTokenEnc ?? null,
        enabled: input.enabled ?? true,
      },
      select: { ...PUBLIC_SELECT, accessTokenEnc: true },
    });
    return this.toPublicRow(created);
  }

  async listForUser(userId: string): Promise<InstancePublicRow[]> {
    const rows = await this.prisma.botInstance.findMany({
      where: { ownerUserId: userId },
      select: { ...PUBLIC_SELECT, accessTokenEnc: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.toPublicRow(row));
  }

  async findForUser(userId: string, id: string): Promise<InstancePublicRow | null> {
    const row = await this.prisma.botInstance.findFirst({
      where: { id, ownerUserId: userId },
      select: { ...PUBLIC_SELECT, accessTokenEnc: true },
    });
    return row ? this.toPublicRow(row) : null;
  }

  async findForConnect(userId: string, id: string): Promise<InstanceConnectConfig | null> {
    return this.prisma.botInstance.findFirst({
      // 归属过滤不能省：拿到别人的 id 也只得到 null
      where: { id, ownerUserId: userId },
      select: CONNECT_SELECT,
    });
  }

  async updateForUser(
    userId: string,
    id: string,
    patch: InstanceUpdatePatch,
  ): Promise<InstancePublicRow | null> {
    if (Object.keys(patch).length === 0) {
      return this.findForUser(userId, id);
    }
    try {
      const updated = await this.prisma.botInstance.update({
        where: { id, ownerUserId: userId },
        data: patch,
        select: { ...PUBLIC_SELECT, accessTokenEnc: true },
      });
      return this.toPublicRow(updated);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return null;
      }
      throw err;
    }
  }

  async deleteForUser(userId: string, id: string): Promise<boolean> {
    const { count } = await this.prisma.botInstance.deleteMany({
      where: { id, ownerUserId: userId },
    });
    return count > 0;
  }

  async setStatusForUser(userId: string, id: string, status: string): Promise<boolean> {
    const { count } = await this.prisma.botInstance.updateMany({
      where: { id, ownerUserId: userId },
      data: { status },
    });
    return count > 0;
  }

  async countForUser(userId: string): Promise<number> {
    return this.prisma.botInstance.count({ where: { ownerUserId: userId } });
  }

  /** 密文在这里被换成布尔值，出了这个函数就只有 `hasAccessToken` */
  private toPublicRow(
    row: Omit<InstancePublicRow, 'hasAccessToken'> & { accessTokenEnc: string | null },
  ): InstancePublicRow {
    const { accessTokenEnc, ...rest } = row;
    return { ...rest, hasAccessToken: Boolean(accessTokenEnc) };
  }
}
