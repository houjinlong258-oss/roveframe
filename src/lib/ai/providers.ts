/** 内置服务商预设：与原型设置页一致，Claude 走 Anthropic 原生协议，其余走 OpenAI 兼容协议 */
export interface ProviderPreset {
  label: string;
  protocol: "anthropic" | "openai";
  baseUrl: string;
  keyHint: string;
  models: string[];
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  claude: {
    label: "Claude (Anthropic)",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    keyHint: "sk-ant-...",
    models: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"],
  },
  openai: {
    label: "OpenAI",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    keyHint: "sk-...",
    models: ["gpt-4o", "gpt-4o-mini", "o4-mini"],
  },
  gemini: {
    label: "Gemini (Google)",
    protocol: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyHint: "AIza...",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
  },
  deepseek: {
    label: "DeepSeek",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    keyHint: "sk-...",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  doubao: {
    label: "豆包（火山引擎）",
    protocol: "openai",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    keyHint: "...",
    models: ["doubao-seed-1-6-250615", "doubao-seed-1-6-flash-250615"],
  },
  kimi: {
    label: "Kimi (Moonshot)",
    protocol: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    keyHint: "sk-...",
    models: ["kimi-k2-0905-preview", "moonshot-v1-32k"],
  },
  qwen: {
    label: "通义千问",
    protocol: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    keyHint: "sk-...",
    models: ["qwen-max", "qwen-plus"],
  },
  glm: {
    label: "智谱 GLM",
    protocol: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    keyHint: "...",
    models: ["glm-4.7", "glm-4.5-air"],
  },
  grok: {
    label: "Grok (xAI)",
    protocol: "openai",
    baseUrl: "https://api.x.ai/v1",
    keyHint: "xai-...",
    models: ["grok-3", "grok-3-mini"],
  },
  custom: {
    label: "自定义（OpenAI 兼容）",
    protocol: "openai",
    baseUrl: "",
    keyHint: "sk-...",
    models: [],
  },
};

/** 平台内置模型（未接入外部服务商时的兜底，也是 auto 模式的候选） */
export const PLATFORM_MODELS = {
  flagship: "doubao-seed-2-0-pro-260215",
  balanced: "doubao-seed-2-0-lite-260215",
  light: "doubao-seed-2-0-mini-260215",
} as const;

export type Capability = "agent" | "content" | "rag" | "light";

/** auto 模式下按任务复杂度分流 */
export const AUTO_ROUTE: Record<Capability, { model: string; temperature: number }> = {
  agent: { model: PLATFORM_MODELS.flagship, temperature: 0.7 },
  content: { model: PLATFORM_MODELS.balanced, temperature: 0.9 },
  rag: { model: PLATFORM_MODELS.balanced, temperature: 0.3 },
  light: { model: PLATFORM_MODELS.light, temperature: 0.3 },
};
