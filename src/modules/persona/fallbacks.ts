/**
 * 故障兜底话术（D026）。
 *
 * 三条硬约束，改代码前先读：
 *
 * 1. **必须是预存文本，不允许在故障时调模型生成。**
 *    故障场景里模型恰好不可用，让它"现编一句"等于制造死循环：调用失败 → 想生成兜底 → 又调模型 → 又失败。
 *
 * 2. **"不说"是合法值，用 `null` 表达，不能用空字符串。**
 *    空串在不同实现里会被当成"发一条空消息"，比不发更诡异，还可能触发平台报错。
 *
 * 3. **不许把运维信息透露给对端。**
 *    对端看到"余额不足""接口限流"只会困惑；这些字眼属于 owner 通知，不属于聊天。
 *
 * 槽位按"对端能感知到什么"划分，不按内部错误码划分。
 */

export const FALLBACK_SLOTS = ['shortOutage', 'longOutage', 'budgetLimit'] as const;
export const FALLBACK_CHANNELS = ['private', 'group'] as const;

export type FallbackSlot = (typeof FALLBACK_SLOTS)[number];
export type FallbackChannel = (typeof FALLBACK_CHANNELS)[number];

/** `null` = 不说 */
export type FallbackTexts = Record<FallbackSlot, Record<FallbackChannel, string | null>>;

/**
 * 默认值。两条原则：
 *   - 不承诺具体时间（"等下"可以，"十分钟后"不行——十分钟后没恢复就是二次失信）
 *   - 不带运维信息
 * 群聊默认全部不说：群里被 @ 多次换来一句"等下找你"，比安静更像刷屏。
 */
export const DEFAULT_FALLBACKS: FallbackTexts = {
  shortOutage: { private: '我这会儿有点事，等下找你', group: null },
  longOutage: { private: null, group: null },
  budgetLimit: { private: '今天有点累了，明天再聊', group: null },
};

/** 单条话术上限。超过 60 字在群里会被拆条，失去"一句话带过"的效果 */
export const FALLBACK_MAX_CHARS = 60;

/** 允许的占位符。其它 `{xxx}` 一律报错，避免用户以为支持模板引擎 */
export const ALLOWED_PLACEHOLDERS = ['nickname', 'groupName'] as const;
export type PlaceholderVar = (typeof ALLOWED_PLACEHOLDERS)[number];

/** 不能出现给对端看的运维字眼 */
const OPS_TERMS = ['余额', '欠费', '充值', '限流', '接口', '额度', 'API', 'Key', 'token'];

const URL_RE = /(https?:\/\/|www\.)/i;
const PLACEHOLDER_RE = /\{([^{}]*)\}/g;

export type FallbackValidation =
  | { ok: true }
  | { ok: false; reason: string };

/** 校验单条话术。`null` 永远合法（表示不说） */
export function validateFallbackText(text: unknown): FallbackValidation {
  if (text === null) {
    return { ok: true };
  }
  if (typeof text !== 'string') {
    return { ok: false, reason: '话术必须是字符串，或 null（表示不说）' };
  }
  if (text.trim().length === 0) {
    return { ok: false, reason: '空字符串会被当成"发一条空消息"，要说就写内容，不说请用 null' };
  }
  // 用 Array.from 数，避免 emoji 被算成两个字符
  if (Array.from(text).length > FALLBACK_MAX_CHARS) {
    return { ok: false, reason: `话术最多 ${FALLBACK_MAX_CHARS} 字（群聊里会被拆条）` };
  }
  if (URL_RE.test(text)) {
    return { ok: false, reason: '话术里不允许出现链接（容易被当成广告或钓鱼）' };
  }
  for (const term of OPS_TERMS) {
    if (text.includes(term)) {
      return { ok: false, reason: `话术里不许出现「${term}」：运维信息只给 owner 看，不给聊天对象看` };
    }
  }
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const name = match[1] ?? '';
    if (!(ALLOWED_PLACEHOLDERS as readonly string[]).includes(name)) {
      return {
        ok: false,
        reason: `不支持的占位符 {${name}}，只允许 ${ALLOWED_PLACEHOLDERS.map((p) => `{${p}}`).join(' / ')}`,
      };
    }
  }
  return { ok: true };
}

/**
 * 解析库里存的 JSON。
 *
 * **容错优先**：人格数据坏了不该让机器人崩，缺项一律回落默认值。
 * 但要区分"缺项"和"显式 null"——后者是用户明确选择"不说"。
 */
export function parseFallbacks(raw: string | null | undefined): FallbackTexts {
  const result: FallbackTexts = {
    shortOutage: { ...DEFAULT_FALLBACKS.shortOutage },
    longOutage: { ...DEFAULT_FALLBACKS.longOutage },
    budgetLimit: { ...DEFAULT_FALLBACKS.budgetLimit },
  };
  if (!raw) {
    return result;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return result;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return result;
  }
  for (const slot of FALLBACK_SLOTS) {
    const slotValue = (parsed as Record<string, unknown>)[slot];
    if (typeof slotValue !== 'object' || slotValue === null) {
      continue;
    }
    for (const channel of FALLBACK_CHANNELS) {
      const value = (slotValue as Record<string, unknown>)[channel];
      if (value === null) {
        result[slot][channel] = null;
      } else if (typeof value === 'string' && validateFallbackText(value).ok) {
        result[slot][channel] = value;
      }
      // 非法值（空串、含链接、超长）直接忽略，保留默认——宁可说一句默认话术，也不要发一条坏消息
    }
  }
  return result;
}

/** 取某个槽位的话术；`null` 表示应当静默 */
export function resolveFallback(
  texts: FallbackTexts,
  slot: FallbackSlot,
  channel: FallbackChannel,
  vars: Partial<Record<PlaceholderVar, string>> = {},
): string | null {
  const template = texts[slot][channel];
  if (template === null) {
    return null;
  }
  return template.replace(PLACEHOLDER_RE, (_whole, name: string) => {
    const value = (vars as Record<string, string | undefined>)[name];
    if (value && value.trim().length > 0) {
      return value;
    }
    // 占位符没值时的兜底：不要留下 `{nickname}` 这种半成品发出去
    return name === 'groupName' ? '群里' : '你';
  });
}

/** 序列化回库。写之前必须逐条校验，避免把非法话术存进去 */
export function serializeFallbacks(texts: FallbackTexts): {
  ok: true; json: string;
} | {
  ok: false; problems: Array<{ slot: FallbackSlot; channel: FallbackChannel; reason: string }>;
} {
  const problems: Array<{ slot: FallbackSlot; channel: FallbackChannel; reason: string }> = [];
  for (const slot of FALLBACK_SLOTS) {
    for (const channel of FALLBACK_CHANNELS) {
      const check = validateFallbackText(texts[slot][channel]);
      if (!check.ok) {
        problems.push({ slot, channel, reason: check.reason });
      }
    }
  }
  if (problems.length > 0) {
    return { ok: false, problems };
  }
  return { ok: true, json: JSON.stringify(texts) };
}
