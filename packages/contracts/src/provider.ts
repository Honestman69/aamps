/**
 * 模型调用契约。
 *
 * 只实现三个协议适配器（见 D006）：
 *   openai-compatible —— DeepSeek / OpenAI / 通义 / 智谱 / Kimi / 硅基流动 / 火山方舟 / Ollama / 中转站
 *   anthropic         —— Claude
 *   gemini            —— Google
 *
 * 铁律：业务代码不直接 fetch 模型接口，一律经过 ModelGateway（见 AGENTS.md 规则 4）。
 * Gateway 负责：路由、解密 DEK、超时、重试、降级、记账。
 */

export type Protocol = 'openai-compatible' | 'anthropic' | 'gemini';

export type AuthStyle = 'bearer' | 'x-api-key' | 'query';

export interface ProviderAuth {
  apiKey: string;
  baseUrl: string;
  authStyle: AuthStyle;
  /** 例如 anthropic-version: 2023-06-01 */
  apiVersion?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ChatResult {
  text: string;
  usage: { tokenIn: number; tokenOut: number };
  model: string;
  finishReason?: string;
}

export interface ModelInfo {
  id: string;
  name?: string;
  contextWindow?: number;
}

export interface ILLMProvider {
  readonly protocol: Protocol;

  chat(req: ChatRequest, auth: ProviderAuth): Promise<ChatResult>;

  /** 逐块产出增量文本；Gateway 负责拼接与最终记账 */
  chatStream(req: ChatRequest, auth: ProviderAuth): AsyncIterable<string>;

  /** 拉取可用模型列表，用于后台"探测模型"与连通性测试 */
  listModels(auth: ProviderAuth): Promise<ModelInfo[]>;
}
