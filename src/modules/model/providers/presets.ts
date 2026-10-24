/**
 * Provider 预设（纯数据，不含逻辑）。
 *
 * 为什么余额查询也放在预设里，而不是在代码里写 `if (provider === 'deepseek')`：
 * 余额接口是**厂商级差异**，不是协议级差异。三个协议适配器（openai-compatible / anthropic / gemini）
 * 里塞厂商特判，等于把 D006 的"3 个协议 + preset"设计破掉。
 *
 * 余额支持的四种状态，必须都表达得出来（D025）：
 *   api          厂商提供余额接口，能事前预警
 *   inferred     只能靠错误码事后确认（如 insufficient_quota）
 *   unsupported  连错误码都不可靠，只能人工看后台
 *   unverified   还没实测过，先别在 UI 上承诺
 *
 * **不要为了"看起来完整"给没验证过的厂商编接口路径**——查不到就显示"未知 + 去厂商后台"，比编一个更好。
 */

export type BalanceDeclaration = {
  method: 'GET';
  /** 相对 provider baseUrl 的路径 */
  path: string;
  /** 从响应 JSON 取值：点路径，数组用 [0]，例如 balance_infos[0].total_balance */
  amountPath: string;
  currencyPath?: string;
  /** 厂商直接给"能不能用"的布尔时填这里，比算金额更可靠 */
  availablePath?: string;
  /** 金额单位：yuan = 元（字符串 "110.00"）；cent = 分（整数） */
  unit: 'yuan' | 'cent';
};

export type BalanceSupport = 'api' | 'inferred' | 'unsupported' | 'unverified' | 'na';

export type ProviderProtocol = 'openai-compatible' | 'anthropic' | 'gemini';

export type ProviderPreset = {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  /** 默认 baseUrl；用户可在凭据里覆盖 */
  baseUrl: string;
  /** 后台"看余额/充值"的落地页。余额查不到时，把它给用户 */
  consoleUrl: string;
  balanceSupport: BalanceSupport;
  /** 仅 balanceSupport='api' 时有值 */
  balance?: BalanceDeclaration;
  /** 给接手的人看的备注：为什么这样标 */
  note?: string;
};

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    consoleUrl: 'https://platform.deepseek.com/top_up',
    balanceSupport: 'api',
    // 官方文档：GET /user/balance → { is_available, balance_infos: [{ currency, total_balance }] }
    // 金额是字符串（"110.00"），单位为元
    balance: {
      method: 'GET',
      path: '/user/balance',
      amountPath: 'balance_infos[0].total_balance',
      currencyPath: 'balance_infos[0].currency',
      availablePath: 'is_available',
      unit: 'yuan',
    },
    note: '官方余额接口已核实，按 Key 查询、只读、轻量，适合定时巡检',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    consoleUrl: 'https://platform.openai.com/settings/organization/billing/overview',
    balanceSupport: 'inferred',
    note: 'API Key 无法查余额；靠 429 insufficient_quota 事后确认，不能事前预警',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    consoleUrl: 'https://console.anthropic.com/settings/billing',
    balanceSupport: 'inferred',
    note: '无 API-Key 级余额接口；credit 不足时返回 400/402，靠错误文案识别',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    consoleUrl: 'https://aistudio.google.com/',
    balanceSupport: 'inferred',
    note: '余额在 GCP 账单里，需要另一套凭证；RESOURCE_EXHAUSTED 只能事后确认',
  },
  {
    id: 'moonshot',
    name: 'Moonshot / Kimi',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    consoleUrl: 'https://platform.moonshot.cn/console/info',
    balanceSupport: 'unverified',
    note: '疑似有 /v1/users/me/balance，未实测；确认后再改成 api 并补声明',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    protocol: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    consoleUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    balanceSupport: 'unverified',
    note: '余额接口未实测',
  },
  {
    id: 'dashscope',
    name: '阿里云百炼 / DashScope',
    protocol: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    consoleUrl: 'https://bailian.console.aliyun.com/',
    balanceSupport: 'unverified',
    note: '余额在阿里云账户里，可能需要 AK/SK 签名；未实测',
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.siliconflow.cn/v1',
    consoleUrl: 'https://cloud.siliconflow.cn/account/ak',
    balanceSupport: 'unverified',
    note: '余额接口未实测',
  },
  {
    id: 'ollama',
    name: 'Ollama（本地）',
    protocol: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434/v1',
    consoleUrl: 'http://127.0.0.1:11434',
    balanceSupport: 'na',
    note: '本地模型没有余额概念；实例预算仍生效（用于限制调用次数）',
  },
  {
    id: 'custom',
    name: '自定义 / 中转',
    protocol: 'openai-compatible',
    baseUrl: '',
    consoleUrl: '',
    balanceSupport: 'unverified',
    note: 'one-api 类中转常见 /api/user/self 或 /v1/dashboard/billing/subscription，视实现而定',
  },
] as const;

export function findProviderPreset(id: string): ProviderPreset | null {
  return PROVIDER_PRESETS.find((preset) => preset.id === id) ?? null;
}

/**
 * 余额能力：UI 与告警文案都从这里取，不要在别处判断 provider 字符串。
 * 返回值直接决定后台显示哪种状态。
 */
export function balanceCapability(providerId: string): BalanceSupport {
  return findProviderPreset(providerId)?.balanceSupport ?? 'unverified';
}
