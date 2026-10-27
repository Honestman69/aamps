/**
 * 人设仓储端口。
 *
 * 归属隔离和凭据一样，**靠 where 里带上 owner**，不是"查出来再判断"：
 * 人设挂在 `BotInstance` 上，所以每条查询都要经过 `instance.ownerUserId`。
 *
 * 没有 `findById`：拿到别人的 personaId 只能得到 null，拿不到"存在但没权限"这个信息。
 */

export type PersonaRow = {
  id: string;
  instanceId: string;
  name: string;
  avatar: string | null;
  tagline: string | null;
  identityJson: string;
  promptBlocksJson: string;
  examplesJson: string;
  openingJson: string;
  boundariesJson: string;
  variablesJson: string;
  behaviorJson: string;
  fallbacksJson: string;
  quoteTendency: string;
  version: number;
  status: string;
  publishedAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PersonaCreateInput = {
  instanceId: string;
  name: string;
  avatar?: string | null;
  tagline?: string | null;
  identityJson?: string;
  promptBlocksJson?: string;
  examplesJson?: string;
  openingJson?: string;
  boundariesJson?: string;
  variablesJson?: string;
  behaviorJson?: string;
  fallbacksJson?: string;
  quoteTendency?: string;
};

/** 只包含"要改的列"，没传的字段一律不出现（避免把没动的字段写成默认值） */
export type PersonaUpdatePatch = Partial<Omit<PersonaCreateInput, 'instanceId' | 'name'>> & {
  name?: string;
  version?: number;
  status?: string;
  publishedAt?: Date | null;
  publishedSnapshot?: string | null;
  archivedAt?: Date | null;
};

export interface IPersonaRepository {
  /** 列表：默认不含已归档（归档是"重置人格"的产物，不该混在编辑列表里） */
  listForInstance(instanceId: string, includeArchived: boolean): Promise<PersonaRow[]>;

  /** 带归属过滤的读取：跨用户返回 null */
  findForUser(userId: string, personaId: string): Promise<PersonaRow | null>;

  /** 写操作前校验实例归属，并取回当前的 activePersonaId */
  findInstanceForUser(
    userId: string,
    instanceId: string,
  ): Promise<{ id: string; activePersonaId: string | null } | null>;

  create(input: PersonaCreateInput): Promise<PersonaRow>;

  update(personaId: string, patch: PersonaUpdatePatch): Promise<PersonaRow>;

  /** `null` = 解除激活（归档当前生效人设时用） */
  setActivePersona(instanceId: string, personaId: string | null): Promise<void>;
}
