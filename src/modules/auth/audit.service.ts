/**
 * 审计日志：只增不改（D009）。
 *
 * 哈希链：`hash = sha256(规范化(prevHash, 本行字段, payloadDigest))`
 * 任何中间记录被删或被改，后续所有 hash 都对不上 —— 包括在数据库层面直接动手。
 *
 * 三条纪律：
 *   1. 本模块**不提供** update / delete 的方法，仓储接口里也没有（`ports.ts`）。
 *   2. payload 入参先过白名单式裁剪，再序列化。裁剪是兜底，不是主要防线：
 *      调用方本来就不该把密钥字段传进来。
 *   3. 追加必须串行。同一进程内用 promise 链串起来；跨进程要靠数据库事务，
 *      当前单进程 + SQLite，先按进程内串行处理（见 D010）。
 */

import { createHash } from 'node:crypto';

import type { IAuditLogRepository } from './ports';

/** 必须记录的动作（SECURITY.md 第 6 节）。新增动作请同步那张表 */
export const AuditAction = {
  CredentialCreate: 'credential.create',
  CredentialUpdate: 'credential.update',
  CredentialDelete: 'credential.delete',
  CredentialRotate: 'credential.rotate',
  CredentialDisableByAdmin: 'credential.disable_by_admin',
  /** DEK 解锁事件：出事时用它回答"明文在哪些时间窗口存在于内存里" */
  CredentialUnlock: 'credential.unlock',
  CredentialLock: 'credential.lock',
  /** 实例：连接动作会解密平台 token，属于密钥相关事件，必须留痕 */
  InstanceCreate: 'instance.create',
  InstanceUpdate: 'instance.update',
  InstanceDelete: 'instance.delete',
  InstanceConnect: 'instance.connect',
  InstanceDisconnect: 'instance.disconnect',
  /** 人设：内容是私人设定，审计里只记 name/status/version，不记正文 */
  PersonaCreate: 'persona.create',
  PersonaUpdate: 'persona.update',
  PersonaPublish: 'persona.publish',
  PersonaArchive: 'persona.archive',
  PersonaActivate: 'persona.activate',
  /** 素材：只记"删了哪张、多大"，图片内容本来就不在库里 */
  AssetDelete: 'asset.delete',
  UserLogin: 'user.login',
  UserLoginFailed: 'user.login_failed',
  UserCreate: 'user.create',
  /** 改显示名 / 角色 / 启停。只记改前改后两个状态，不记密码材料 */
  UserUpdate: 'user.update',
  UserPasswordChange: 'user.password_change',
  UserPasswordReset: 'user.password_reset',
  UserPasswordResetSelf: 'user.password_reset_self',
  AdminImpersonate: 'admin.impersonate',
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

/** 操作者类型。`system` 给定时任务，`worker` 给后台任务 */
export type AuditActor = 'superadmin' | 'user' | 'system' | 'worker';

export type AuditLogRow = {
  id: string;
  tenantId: string;
  actorUserId: string | null;
  actor: string;
  action: string;
  target: string | null;
  targetOwnerId: string | null;
  ip: string | null;
  beforeJson: string | null;
  afterJson: string | null;
  prevHash: string | null;
  hash: string;
  createdAt: Date;
};

/** 参与计算 hash 的字段（顺序即规范化顺序，不要重排） */
export type AuditHashInput = Pick<
  AuditLogRow,
  | 'prevHash'
  | 'actorUserId'
  | 'actor'
  | 'action'
  | 'target'
  | 'targetOwnerId'
  | 'ip'
  | 'beforeJson'
  | 'afterJson'
  | 'createdAt'
>;

/**
 * 兜底裁剪：**按字段名精确判定 + 按值形态兜底**，不做"名字里含 dek 就抹"的模糊匹配。
 *
 * 这里踩过一次：最初用 /(dek|key|token|...)/ 这种宽正则，把 `dekVersion`
 * 和 `wrapDekDestroyed` 也抹成了 [redacted]，审计记录当场失去意义
 * （"重置时到底销毁了没有"看不出来）。安全措施不能把审计本身废掉。
 *
 * 三层规则，按顺序：
 *   1. 明确安全的元数据字段（白名单）→ 放行
 *   2. 明确敏感的字段名（精确匹配 / 明确后缀）→ 抹掉
 *   3. 值本身长得像密钥材料（`dek:v1:` / `wrap:v1:` / sk-xxx / 长 hex）→ 抹掉
 */
const SAFE_META_FIELDS = new Set(
  [
    'dekVersion',
    'dekCreated',
    'wrapDekDestroyed',
    'keysUnaffected',
    'rewrapped',
    'disabledCredentials',
    'clearedSessions',
    'keyMasked',
    'reason',
    'enabled',
    'provider',
    'label',
    'model',
    'role',
    'status',
  ].map((name) => name.toLowerCase()),
);

/** 精确匹配的敏感字段名（都按小写比较） */
const SECRET_FIELD_NAMES = new Set(
  [
    'apiKey',
    'api_key',
    'apiKeyEnc',
    'password',
    'passwordHash',
    'passwd',
    'secret',
    'token',
    'accessToken',
    'appSecret',
    'dek',
    'wrappedDek',
    'keySalt',
    'salt',
    'cipher',
    'ciphertext',
    'iv',
    'tag',
    'credentialSecret',
  ].map((name) => name.toLowerCase()),
);

/** 明确以敏感语义结尾的字段（驼峰命名下的通用兜底） */
const SECRET_SUFFIX_RE = /(Enc|Secret|Token|Password|Passwd)$/;

/** 值形态兜底：即使字段名叫 remark，值长成这样也不许入审计 */
const SECRET_VALUE_RES = [
  /^dek:v1:/,
  /^wrap:v1:/,
  /^enc:v1:/,
  /^sk-[A-Za-z0-9_-]{8,}$/,
  /^[A-Fa-f0-9]{32,}$/,
];

const REDACTED = '[redacted]';

function looksLikeSecretValue(value: string): boolean {
  return SECRET_VALUE_RES.some((re) => re.test(value));
}

function shouldRedactField(name: string): boolean {
  const lower = name.toLowerCase();
  if (SAFE_META_FIELDS.has(lower)) {
    return false;
  }
  if (SECRET_FIELD_NAMES.has(lower)) {
    return true;
  }
  return SECRET_SUFFIX_RE.test(name);
}

function redactValue(value: unknown, depth = 0, parentKey?: string): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (depth > 4) {
    return '[too-deep]';
  }
  if (parentKey && shouldRedactField(parentKey)) {
    return REDACTED;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactValue(val, depth + 1, key);
    }
    return out;
  }
  if (typeof value === 'string') {
    if (looksLikeSecretValue(value)) {
      return REDACTED;
    }
    // 长度为 0 的字符串保留原样，便于区分"空"和"未提供"
    return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return String(value);
}

/** 把任意 payload 裁成可入库的 JSON 字符串；undefined 统一成 null，避免出现两种"空" */
export function toAuditJson(payload: unknown): string | null {
  if (payload === null || payload === undefined) {
    return null;
  }
  return JSON.stringify(redactValue(payload));
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 固定分隔符，防止字段拼接产生歧义（用不可见字符，业务文本里不会出现） */
const FIELD_SEP = '\u0001';

function payloadDigest(input: AuditHashInput): string {
  return sha256(`${input.beforeJson ?? ''}\u0000${input.afterJson ?? ''}`);
}

/**
 * 计算一行的 hash。
 * `createdAt` 参与计算，所以**不要**在写入后修改时间字段（改了就校验失败）。
 */
export function computeAuditHash(input: AuditHashInput): string {
  const canonical = [
    'v1',
    input.prevHash ?? '',
    input.actorUserId ?? '',
    input.actor,
    input.action,
    input.target ?? '',
    input.targetOwnerId ?? '',
    input.ip ?? '',
    input.createdAt.toISOString(),
    payloadDigest(input),
  ].join(FIELD_SEP);
  return sha256(canonical);
}

export type ChainVerifyResult =
  | { ok: true; checked: number }
  | { ok: false; checked: number; brokenAtId: string; index: number; reason: string };

/**
 * 从最早一条重算到最新，报出断点。
 * 输入必须是按 `createdAt` 升序（同时间按 id 稳定排序）的记录。
 */
export function verifyAuditChain(rows: AuditLogRow[]): ChainVerifyResult {
  let prevHash: string | null = null;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (row.prevHash !== prevHash) {
      return {
        ok: false,
        checked: i,
        brokenAtId: row.id,
        index: i,
        reason: 'prevHash 与上一条记录不衔接（中间记录可能被删除或插入）',
      };
    }
    const expected = computeAuditHash(row);
    if (expected !== row.hash) {
      return {
        ok: false,
        checked: i,
        brokenAtId: row.id,
        index: i,
        reason: 'hash 与内容不匹配（记录可能被修改）',
      };
    }
    prevHash = row.hash;
  }
  return { ok: true, checked: rows.length };
}

export type RecordAuditInput = {
  tenantId: string;
  actor: AuditActor;
  actorUserId?: string | null;
  action: AuditAction;
  target?: string | null;
  targetOwnerId?: string | null;
  ip?: string | null;
  before?: unknown;
  after?: unknown;
};

export class AuditService {
  /** 进程内串行队列：保证 prevHash 读取与 append 之间不会插进另一条 */
  private tail: Promise<unknown> = Promise.resolve();
  /**
   * 上一条的时间戳（进程内快路径）。
   *
   * 注意：**不能只依赖这个字段**。它活在内存里，进程重启就没了；
   * 如果重启后系统时钟恰好比库里最后一条的时间还早（NTP 回拨、容器时区/时钟漂移），
   * 新记录的 `createdAt` 就会排到历史记录前面，校验时会误报"断链"。
   * 所以真正的时间下限取自**数据库最后一条**，内存字段只是省一次比较。
   */
  private lastCreatedAt: Date | null = null;

  constructor(
    private readonly repo: IAuditLogRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** 追加一条审计。payload 会被裁剪，绝不会把密钥写进去 */
  async record(input: RecordAuditInput): Promise<AuditLogRow> {
    const run = async (): Promise<AuditLogRow> => {
      const last = await this.repo.lastForTenant(input.tenantId);
      const createdAt = this.nextTimestamp(last?.createdAt ?? null);
      const draft: Omit<AuditLogRow, 'id'> = {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId ?? null,
        actor: input.actor,
        action: input.action,
        target: input.target ?? null,
        targetOwnerId: input.targetOwnerId ?? null,
        ip: input.ip ?? null,
        beforeJson: toAuditJson(input.before),
        afterJson: toAuditJson(input.after),
        prevHash: last?.hash ?? null,
        hash: '',
        createdAt,
      };
      draft.hash = computeAuditHash(draft);
      const saved = await this.repo.append(draft);
      this.lastCreatedAt = createdAt;
      return saved;
    };

    // 链式排队：前一条失败也不能卡死后续
    const queued = this.tail.then(run, run);
    this.tail = queued.catch(() => undefined);
    return queued;
  }

  /**
   * 取当前时间，并保证**严格晚于**上一条记录（同时参考数据库最后一条）。
   * 时钟回拨或重启后时钟偏早都不会破坏链。
   */
  private nextTimestamp(lastInDb: Date | null): Date {
    const now = this.clock();
    const floor = lastInDb && this.lastCreatedAt
      ? new Date(Math.max(lastInDb.getTime(), this.lastCreatedAt.getTime()))
      : (lastInDb ?? this.lastCreatedAt);
    if (floor && now.getTime() <= floor.getTime()) {
      return new Date(floor.getTime() + 1);
    }
    return now;
  }

  /** 校验某租户的哈希链，返回断点 */
  async verifyTenant(tenantId: string, limit = 10000): Promise<ChainVerifyResult> {
    const rows = await this.repo.listForVerify(tenantId, limit);
    return verifyAuditChain(rows);
  }

  /** 后台展示用：最近 N 条（倒序） */
  async listRecent(tenantId: string, limit = 100): Promise<AuditLogRow[]> {
    return this.repo.listRecent(tenantId, limit);
  }
}
