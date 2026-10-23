/**
 * 统一错误类型。
 *
 * 约束（见 docs/CONVENTIONS.md）：
 *   1. 错误信息里不允许出现密钥、Token、完整 QQ 号 —— 错误会被记日志，也可能被前端展示。
 *   2. 权限不足一律抛 ForbiddenError，不区分"资源不存在"和"无权限"，防枚举。
 */

export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number = 500,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class BadRequestError extends AppError {
  constructor(message: string) {
    super('BAD_REQUEST', message, 400);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = '请先登录') {
    super('UNAUTHORIZED', message, 401);
  }
}

/** 权限不足。故意不告诉调用方"到底存不存在" */
export class ForbiddenError extends AppError {
  constructor(message = '无权访问') {
    super('FORBIDDEN', message, 403);
  }
}

/**
 * 密钥库未解锁（DEK 不在内存）。
 * 这是"服务重启后需要用户重新解锁"这条设计的运行期表现，见 D005。
 * 上层必须转成明确的解锁提示，不允许静默降级。
 */
export class KeyLockedError extends AppError {
  constructor(message = '密钥库未解锁，请重新输入密码解锁') {
    super('KEY_LOCKED', message, 401);
  }
}

/** 外部模型服务错误。retryable 决定 Gateway 是否重试（401/403/402 一律不重试） */
export class ProviderError extends AppError {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly upstreamStatus?: number,
  ) {
    super('PROVIDER_ERROR', message, 502);
  }
}

/** 命中行为约束词或规则引擎 */
export class RuleBlockedError extends AppError {
  constructor(
    readonly ruleId: string,
    message = '命中规则',
  ) {
    super('RULE_BLOCKED', message, 200);
  }
}
