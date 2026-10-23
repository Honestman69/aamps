/**
 * 首次启动的种子：创建一个 superadmin。
 *
 * 为什么单独一个服务而不是塞进 `main.ts`：
 *   建号必须写审计（谁在什么时候造了一个最高权限账号），而审计要哈希链；
 *   把这段逻辑放在启动流程里用 prisma 直接 create，就会绕过审计。
 *
 * 密码来源只有环境变量 `BOOTSTRAP_ADMIN_PASSWORD`，且**只用于建号那一次**：
 * 建完就该清掉（运维纪律，见 .env.example 注释）。
 * 这个服务不会在账号已存在时改密码 —— 否则就成了"改配置文件就能重置管理员密码"的后门。
 */

import { BadRequestError } from '@newjob/contracts';

import { hashPassword, randomSalt } from '../../common/crypto';
import { AuditAction, AuditService } from './audit.service';
import { MIN_PASSWORD_LENGTH } from './password.service';
import type { ITenantRepository, IUserProvisionRepository } from './ports';

export type BootstrapInput = {
  username: string;
  password: string;
  displayName?: string | null;
  tenantSlug?: string;
  tenantName?: string;
};

export type BootstrapResult = {
  created: boolean;
  userId?: string;
  /** 未创建时给出原因，便于启动日志直接打印（不包含密码） */
  reason?: string;
};

export class BootstrapService {
  constructor(
    private readonly deps: {
      tenants: ITenantRepository;
      users: IUserProvisionRepository;
      audit: AuditService;
    },
  ) {}

  async ensureSuperadmin(input: BootstrapInput): Promise<BootstrapResult> {
    const password = input.password?.trim() ?? '';
    if (!password) {
      return { created: false, reason: '未配置初始管理员密码，跳过创建' };
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new BadRequestError(`初始管理员密码至少 ${MIN_PASSWORD_LENGTH} 位`);
    }

    const username = input.username.trim();
    if (!username) {
      throw new BadRequestError('初始管理员用户名不能为空');
    }

    if (await this.deps.users.existsByUsername(username)) {
      // 已存在就什么都不做。改密码必须走 password_reset（会销毁 Key 并留痕）
      return { created: false, reason: '账号已存在，跳过创建' };
    }

    const tenantSlug = input.tenantSlug ?? 'default';
    const tenant = await this.deps.tenants.ensureTenant(tenantSlug, input.tenantName ?? '自用');

    const passwordHash = await hashPassword(password);
    const keySalt = randomSalt().toString('hex');

    const created = await this.deps.users.createUser({
      tenantId: tenant.id,
      username,
      displayName: input.displayName ?? username,
      role: 'superadmin',
      passwordHash,
      keySalt,
    });

    await this.deps.audit.record({
      tenantId: tenant.id,
      actor: 'system',
      actorUserId: null,
      action: AuditAction.UserCreate,
      target: `user:${created.id}`,
      targetOwnerId: created.id,
      after: { username, role: 'superadmin', dekInitialized: false },
    });

    return { created: true, userId: created.id };
  }
}
