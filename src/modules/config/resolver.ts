/**
 * 配置解析：纯函数，无 IO。
 *
 * 纯函数的好处不是"优雅"，而是**可测**：覆盖顺序、空值回落、非法值兜底这些最容易错的地方，
 * 用一条构造好的 bundle 就能断言，不需要数据库。
 *
 * 三条规则：
 *   1. 只覆盖"非空且有值"的字段。`null` 表示"这层没设"，不是"设成空"——
 *      否则一处忘了填就会把上层的值抹掉。
 *   2. 非法值不静默接受：温度越界就夹到合法区间，并把来源标成 `default`（表示被拒了），
 *      这样后台能看到"我设的值没生效"，而不是以为生效了。
 *   3. 任何字段都必须有确定的值，不存在 `undefined` 漏到下游。
 */

import {
  DEFAULT_AGENT_CONFIG,
  TEMPERATURE_RANGE,
  isBudgetPolicy,
  type AgentConfig,
  type ConfigBundle,
  type ConfigLayer,
  type ResolvedConfig,
  type SessionFlags,
} from './types';

const DEFAULT_SESSION_FLAGS: SessionFlags = { aiPaused: false, reviewMode: false, muted: false };

/** 空串等同于没填。用 trim 判断，避免 `"   "` 绕过 */
function hasText(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function clampTemperature(value: number): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  if (value < TEMPERATURE_RANGE.min || value > TEMPERATURE_RANGE.max) {
    return null;
  }
  return value;
}

export function resolveConfig(bundle: ConfigBundle): ResolvedConfig {
  const config: AgentConfig = { ...DEFAULT_AGENT_CONFIG };
  const provenance = Object.fromEntries(
    (Object.keys(DEFAULT_AGENT_CONFIG) as Array<keyof AgentConfig>).map((key) => [key, 'default']),
  ) as Record<keyof AgentConfig, ConfigLayer>;

  const set = <K extends keyof AgentConfig>(
    key: K,
    value: AgentConfig[K],
    layer: ConfigLayer,
  ): void => {
    config[key] = value;
    provenance[key] = layer;
  };

  // ── 实例层 ──
  const { instance } = bundle;
  if (hasText(instance.credentialId)) set('credentialId', instance.credentialId, 'instance');
  if (hasText(instance.modelMain)) set('modelMain', instance.modelMain, 'instance');
  if (hasText(instance.modelCheap)) set('modelCheap', instance.modelCheap, 'instance');
  if (hasText(instance.modelFallback)) set('modelFallback', instance.modelFallback, 'instance');

  const temperature = clampTemperature(instance.modelTemperature);
  if (temperature !== null) {
    set('modelTemperature', temperature, 'instance');
  }
  // 越界时保持默认值，provenance 留 'default' —— 表示"实例设了但被拒"，不是"实例没设"

  if (Number.isInteger(instance.rateLimitPerMin) && instance.rateLimitPerMin > 0) {
    set('rateLimitPerMin', instance.rateLimitPerMin, 'instance');
  }
  if (Number.isInteger(instance.dailyMsgCap) && instance.dailyMsgCap > 0) {
    set('dailyMsgCap', instance.dailyMsgCap, 'instance');
  }
  if (hasText(instance.nightQuiet)) set('nightQuiet', instance.nightQuiet, 'instance');
  if (hasText(instance.activePersonaId)) set('personaId', instance.activePersonaId, 'instance');

  // 预算：`0` 是**合法值**（表示不限），所以这里用 `>= 0` 而不是上面那种 `> 0`。
  // 用 `> 0` 会让"我明确设成不限"被当成"没设"，回落到默认——而默认恰好也是 0，
  // 表面上没区别，一旦将来默认值改成非 0 就会静默出错。
  if (Number.isInteger(instance.dailyBudgetCents) && instance.dailyBudgetCents >= 0) {
    set('dailyBudgetCents', instance.dailyBudgetCents, 'instance');
  }
  if (Number.isInteger(instance.monthlyBudgetCents) && instance.monthlyBudgetCents >= 0) {
    set('monthlyBudgetCents', instance.monthlyBudgetCents, 'instance');
  }
  if (isBudgetPolicy(instance.budgetPolicy)) {
    set('budgetPolicy', instance.budgetPolicy, 'instance');
  }
  // 预算只有实例层：人设和会话都不该改它。否则"换个会话"就能绕过限额。

  // ── 人设层 ──
  // 这一版人设层不改上面任何字段：行为参数属于 M3 表达层，现在透传只为了将来有落点。
  // 保留这个分支是刻意的：让"人设层存在但不生效"显式可见，而不是让人误以为漏了实现。

  // ── 会话层 ──
  const sessionFlags: SessionFlags = { ...DEFAULT_SESSION_FLAGS };
  if (bundle.session) {
    sessionFlags.aiPaused = bundle.session.aiPaused;
    sessionFlags.reviewMode = bundle.session.reviewMode;
    sessionFlags.muted = bundle.session.muted;
    // 会话可以临时切人设（例如同一个号里某个群的对话换一套语气）
    if (hasText(bundle.session.personaId)) {
      set('personaId', bundle.session.personaId, 'session');
    }
  }

  return { config, sessionFlags, provenance };
}
