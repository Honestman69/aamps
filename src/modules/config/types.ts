/**
 * 配置解析的领域类型（D007 四级覆盖）。
 *
 * 覆盖链：**租户默认（代码常量） → 实例 → 人设 → 会话**
 *
 * 为什么要记录"这个值来自哪层"（provenance）：
 * 配置出问题时最多的疑问是"为什么它用的是这个模型/这个上限"。没有来源信息，
 * 只能人肉翻三张表；有来源，一眼看出是哪层覆盖掉了。
 *
 * 为什么人设层（Persona）现在几乎不参与：
 * 人设的行为参数（拆条、打字速度等）属于 M3 表达层；这里只保留 `personaId` 与 `behavior`
 * 的透传，避免现在编一套没人消费的字段。等 M3 真正读的时候再加字段，而不是先留一堆空壳。
 */

export const CONFIG_LAYERS = ['default', 'instance', 'persona', 'session'] as const;
export type ConfigLayer = (typeof CONFIG_LAYERS)[number];

/** 可被逐层覆盖的字段 */
export type AgentConfig = {
  /** 用哪把 Key；`null` = 还没配，网关应拒绝调用并提示 */
  credentialId: string | null;
  modelMain: string;
  modelCheap: string;
  modelFallback: string | null;
  modelTemperature: number;
  rateLimitPerMin: number;
  dailyMsgCap: number;
  nightQuiet: string;
  /** 当前生效的人设；会话层可以临时换 */
  personaId: string | null;
  /** 人格预算（D024）：`0` = 不限。挂在实例上，人设/会话不得覆盖 */
  dailyBudgetCents: number;
  monthlyBudgetCents: number;
  /** 超限策略：降级到 modelCheap 继续，还是直接不出声（D024） */
  budgetPolicy: BudgetPolicy;
};

/** 预算超限后的动作。与 Prisma 里的字符串枚举保持一致 */
export const BUDGET_POLICIES = ['downgrade', 'block'] as const;
export type BudgetPolicy = (typeof BUDGET_POLICIES)[number];

export function isBudgetPolicy(value: unknown): value is BudgetPolicy {
  return typeof value === 'string' && (BUDGET_POLICIES as readonly string[]).includes(value);
}

/** 会话级的运行时开关，不属于"配置"，但 Pipeline 每次都要读 */
export type SessionFlags = {
  aiPaused: boolean;
  reviewMode: boolean;
  muted: boolean;
};

export type ResolvedConfig = {
  config: AgentConfig;
  sessionFlags: SessionFlags;
  /** 每个字段最终由哪一层决定 */
  provenance: Record<keyof AgentConfig, ConfigLayer>;
};

/**
 * 代码里的兜底默认值。租户层目前没有可配字段（Tenant 只有 plan/quota），
 * 所以"租户层"在这一版等于这些常量；将来加租户级配置时只需在这一层之上再套一层。
 */
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  credentialId: null,
  modelMain: 'deepseek-chat',
  modelCheap: 'deepseek-chat',
  modelFallback: null,
  modelTemperature: 0.85,
  rateLimitPerMin: 20,
  dailyMsgCap: 800,
  nightQuiet: '00:30-07:30',
  personaId: null,
  // 默认不限额：新装的实例不该因为一条默认预算就哑掉
  dailyBudgetCents: 0,
  monthlyBudgetCents: 0,
  budgetPolicy: 'downgrade',
};

/** 温度合法区间：低于 0 没意义，高于 1.5 输出开始胡言乱语 */
export const TEMPERATURE_RANGE = { min: 0, max: 1.5 } as const;

/** 从数据库载入的原始上下文（可空 = 该层没数据/没这个人设） */
export type ConfigBundle = {
  instance: {
    credentialId: string | null;
    modelMain: string | null;
    modelCheap: string | null;
    modelFallback: string | null;
    modelTemperature: number;
    rateLimitPerMin: number;
    dailyMsgCap: number;
    nightQuiet: string;
    activePersonaId: string | null;
    dailyBudgetCents: number;
    monthlyBudgetCents: number;
    budgetPolicy: string;
  };
  /** 当前生效的人设（若 activePersonaId 指向的那条） */
  persona: {
    id: string;
    behaviorJson: string;
  } | null;
  session: {
    id: string;
    personaId: string | null;
    aiPaused: boolean;
    reviewMode: boolean;
    muted: boolean;
  } | null;
};
