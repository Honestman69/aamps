/**
 * auth 模块的端口（Repository 接口）。
 *
 * 为什么先定接口而不是直接写 Prisma：
 *   1. `password.service` / `unlock.service` 是可以纯逻辑测试的核心，不该被数据库拖住；
 *   2. 签名里写清楚"这次查询凭什么定位用户"，逼着实现方不能偷偷 `findMany()` 全表捞；
 *   3. 单事务 / CAS（比较后写入）这类要求只能落在 Repository 层，写在 Service 里一定会漏。
 *
 * 命名刻意不用 `findById`（AGENTS.md 硬性规则 5）：每个方法都要能看懂它的作用域。
 */

import type { AuditLogRow } from './audit.service';

/** 认证场景下能看到的用户字段。**故意不含**任何明文密钥材料 */
export type UserAuthRecord = {
  id: string;
  tenantId: string;
  username: string;
  role: string;
  status: string;
  passwordHash: string;
  /** 16B，hex 编码。它只是盐，泄漏了没有密码也没用 */
  keySalt: string;
  /** 被 KEK 包裹的 DEK；`null` 表示尚未初始化或已被重置销毁 */
  wrappedDek: string | null;
  dekVersion: number;
};

/**
 * 用户仓储（认证用途）。
 *
 * 所有写方法都是 **CAS（比较后写入）**：调用方必须带上它读到的旧值，
 * 只有数据库里仍是旧值时才更新成功。这样两个并发的改密请求不会互相覆盖，
 * 也不会出现"passwordHash 写成新的、wrappedDek 还是旧的"这种致命错配
 * （见 SECURITY.md 5.1：这种数据损坏最难排查）。
 */
export interface IUserAuthRepository {
  /** 登录用：按用户名取 */
  findForLogin(username: string): Promise<UserAuthRecord | null>;

  /** 解锁 / 改密用：只能由已认证的会话拿自己的 userId 调用 */
  findAuthById(userId: string): Promise<UserAuthRecord | null>;

  /**
   * 本人改密码：单事务内同时更新 `passwordHash` 与 `wrappedDek`。
   * 任一字段写入失败必须整体回滚（DEK 已重包裹但哈希没写 = 用户被锁在门外）。
   */
  updateSecretsAtomically(input: {
    userId: string;
    expectPasswordHash: string;
    expectWrappedDek: string;
    passwordHash: string;
    wrappedDek: string;
  }): Promise<boolean>;

  /**
   * 重置密码：换新密码 + 销毁 `wrappedDek` + `dekVersion + 1`，单事务。
   * 语义见 D004：重置必然等于密钥销毁，因为没有旧密码就解不出 DEK。
   */
  replacePasswordAndDestroyDek(input: {
    userId: string;
    passwordHash: string;
    expectDekVersion: number;
  }): Promise<boolean>;

  /**
   * 首次登录（或重置后第一次登录）时，把新生成的 wrappedDek 写进去。
   * 仅当当前 `wrappedDek` 仍为 null 且 `dekVersion` 未变时成功，防止并发登录各建一把 DEK。
   */
  attachDekIfAbsent(input: {
    userId: string;
    wrappedDek: string;
    expectDekVersion: number;
  }): Promise<boolean>;

  /** 登录成功时间，纯展示用途 */
  touchLastLogin(userId: string, at: Date): Promise<void>;
}

/**
 * 凭据仓储（重置密码时批量停用）。
 * 这里只暴露"按用户停用"，不暴露任何读取明文的路径 —— 那个 action 在权限枚举里根本不存在。
 */
export interface ICredentialAdminRepository {
  disableAllForUser(userId: string, reason: string): Promise<number>;
}

/**
 * 用户创建（种子 / 用户管理用）。
 * 刻意与 `IUserAuthRepository` 分开：认证链路只该读，不该有建号能力。
 */
export interface IUserProvisionRepository {
  existsByUsername(username: string): Promise<boolean>;

  /**
   * 建号时**只写 keySalt，不生成 DEK**。
   * DEK 等用户首次登录解锁时才生成并包裹（SECURITY.md 4.1），
   * 建号方因此永远拿不到任何能解开 Key 的材料。
   */
  createUser(input: {
    tenantId: string;
    username: string;
    displayName?: string | null;
    role: string;
    passwordHash: string;
    keySalt: string;
  }): Promise<{ id: string }>;
}

/** 租户（自用阶段只有一个 default） */
export interface ITenantRepository {
  ensureTenant(slug: string, name: string): Promise<{ id: string }>;
}

/**
 * 管理端用户查询：**只有脱敏字段**。
 * 类型里没有 `wrappedDek` / `keySalt`，所以"管理员能不能看到密钥材料"这个问题
 * 在编译期就答完了（SECURITY.md 第 8 条第 3 条）。
 */
export type UserAdminDTO = {
  id: string;
  username: string;
  displayName: string | null;
  role: string;
  status: string;
  /** DEK 是否已初始化（是布尔，不是密文） */
  dekInitialized: boolean;
  dekVersion: number;
  lastLoginAt: string | null;
  createdAt: string;
};

export interface IUserAdminQueryRepository {
  listForAdmin(tenantId: string): Promise<UserAdminDTO[]>;
  /**
   * 只在同一租户内可见，跨租户一律当作"无权"。
   *
   * 返回 `role` / `status` 是给"改人之前先看当前值"用的：
   * 判断"是不是在改自己""角色有没有真的变"都需要它们，
   * 否则上层只能再发一次查询（或者在请求体里相信前端传来的旧值）。
   */
  findForAdmin(
    userId: string,
    tenantId: string,
  ): Promise<{
    id: string;
    username: string;
    displayName: string | null;
    role: string;
    status: string;
  } | null>;
}

/**
 * 管理端用户写端口（建号 / 改资料 · 角色 · 启停）。
 *
 * 与 `IUserProvisionRepository.createUser` 分开：那个是"种子/建号"的窄接口，
 * 这里是后台管理面。两者共用同一张表，但职责不同 —— 建号只写 keySalt（不生成 DEK），
 * 改角色/启停则涉及会话与内存 DEK 的撤销，语义完全不一样。
 *
 * 所有方法都带 `tenantId`：跨租户写不进去，不靠上层判断。
 */
export interface IUserAdminMutationRepository {
  /** 返回 false = 不存在 / 不属于这个租户 */
  updateForAdmin(input: {
    tenantId: string;
    userId: string;
    displayName?: string | null;
    role?: string;
    status?: string;
  }): Promise<boolean>;
}

/** 审计仓储：只提供 append 与读取，**没有 update / delete 方法**（D009） */export interface IAuditLogRepository {
  /**
   * 追加一行，并返回实际写入的记录。
   * 实现方必须保证串行（Prisma 事务内先读最后一条再写），否则哈希链会分叉。
   */
  append(row: Omit<AuditLogRow, 'id'>): Promise<AuditLogRow>;

  /** 取该租户最新一条（用于算 prevHash） */
  lastForTenant(tenantId: string): Promise<Pick<AuditLogRow, 'hash' | 'createdAt'> | null>;

  /** 按时间正序取出用于校验 */
  listForVerify(tenantId: string, limit: number): Promise<AuditLogRow[]>;

  /** 按时间倒序取最近记录（后台展示用） */
  listRecent(tenantId: string, limit: number): Promise<AuditLogRow[]>;
}
