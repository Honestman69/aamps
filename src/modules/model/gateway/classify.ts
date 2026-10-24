/**
 * Provider 调用的错误分类（D025）。
 *
 * 为什么单独一个纯函数：分类错了，后面全错——
 * 把 `balance` 判成 `auth`，用户会去重新申请 Key（白折腾）；
 * 把 `auth` 判成 `network`，系统会一直重试一个永远不会成功的请求。
 *
 * 分类结果直接决定：是否重试、冷却多久、对端要不要出声、owner 看到什么。
 */

export const UNAVAILABLE_REASONS = ['balance', 'auth', 'rate_limit', 'provider', 'network'] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

export type ClassifiedError = {
  reason: UnavailableReason;
  /** 是否值得再试一次（同一个 Key / 同一个模型） */
  retryable: boolean;
  /** 建议冷却时长（毫秒）。0 表示不落库冷却，只重试 */
  cooldownMs: number;
};

/** 各原因的默认策略：重试与否 + 冷却时长 */
const POLICY: Record<UnavailableReason, { retryable: boolean; cooldownMs: number }> = {
  // 欠费只能等充值：不重试，冷却 30 分钟（充值后由巡检或手动重测恢复）
  balance: { retryable: false, cooldownMs: 30 * 60 * 1000 },
  // Key 失效/无权限：不重试，冷却 1 小时（用户换 Key 后手动重测即可提前恢复）
  auth: { retryable: false, cooldownMs: 60 * 60 * 1000 },
  // 限流会自愈：可以重试一次，冷却 1 分钟
  rate_limit: { retryable: true, cooldownMs: 60 * 1000 },
  // 厂商 5xx：可重试，冷却 5 分钟（冷却只是给下一轮请求参考）
  provider: { retryable: true, cooldownMs: 5 * 60 * 1000 },
  // 网络：可重试，不冷却（本机网络问题不该怪到 Key 头上）
  network: { retryable: true, cooldownMs: 0 },
};

/** 余额相关的文案特征。厂商不统一，只能靠这些关键词兜住主流几家 */
const BALANCE_HINTS = [
  'insufficient_quota',
  'insufficient balance',
  'insufficient_balance',
  'credit balance',
  'exceeded your current quota',
  '余额不足',
  '欠费',
  'quota_exceeded',
];

const AUTH_HINTS = ['invalid_api_key', 'invalid api key', 'unauthorized', 'authentication', 'api key'];

function containsAny(text: string, needles: string[]): boolean {
  const lower = text.toLowerCase();
  return needles.some((needle) => lower.includes(needle.toLowerCase()));
}

/**
 * 按 HTTP 状态码 + 响应体分类。
 *
 * 注意 `402` 与 `429` 都会被拿来表达"额度"问题，所以先看文案再看状态码：
 * OpenAI 欠费返回 429 + `insufficient_quota`，只按状态码判会误判成"限流"，
 * 然后无限重试一个永远不会成功的请求。
 */
export function classifyFailure(input: {
  status?: number | null;
  body?: string | null;
  /** AbortError / ECONNRESET 这类没有 HTTP 状态的失败 */
  networkError?: boolean;
}): ClassifiedError {
  if (input.networkError || !input.status) {
    return { reason: 'network', ...POLICY.network };
  }

  const body = input.body ?? '';

  // 1) 文案优先：欠费与限流都可能用 429/402 表达
  if (containsAny(body, BALANCE_HINTS)) {
    return { reason: 'balance', ...POLICY.balance };
  }
  if (input.status === 402) {
    return { reason: 'balance', ...POLICY.balance };
  }

  // 2) 状态码
  if (input.status === 401 || input.status === 403) {
    return { reason: 'auth', ...POLICY.auth };
  }
  if (input.status === 429) {
    // 429 且文案里没有余额特征 → 真限流
    return { reason: 'rate_limit', ...POLICY.rate_limit };
  }
  if (input.status >= 500) {
    return { reason: 'provider', ...POLICY.provider };
  }

  // 3) 其余 4xx：多半是请求本身有问题（模型名不对/参数错）。
  //    归到 `provider` 但不重试也没意义——用 provider 的冷却策略但不重试，避免死循环。
  if (input.status >= 400) {
    return { reason: 'provider', retryable: false, cooldownMs: POLICY.provider.cooldownMs };
  }

  return { reason: 'network', ...POLICY.network };
}

/** Key 自身不可用（不该重试同一把 Key，应换下一把） */
export function isKeyLevelFailure(reason: UnavailableReason): boolean {
  return reason === 'balance' || reason === 'auth';
}
