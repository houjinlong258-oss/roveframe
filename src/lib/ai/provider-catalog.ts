/**
 * RoveFrame Provider Catalog —— 统一的 Provider Universe。
 *
 * 设计原则：provider catalog 的实现与数据均由 RoveFrame 维护：
 * - provider slug 与显示名分离；认证类型与传输协议分离。
 * - Base URL 可覆盖；模型目录可更新、可手动填写 model ID。
 * - 配置界面与运行时路由使用同一份 Catalog。
 * - 协议不同的服务商使用独立 adapter；不把所有服务商当成 OpenAI。
 *
 * runtime 字段声明当前服务端 adapter 的真实支持级别：
 * - "native"：有独立协议实现（openai_chat / anthropic_messages）。
 * - "openai_compat"：通过服务商官方 OpenAI 兼容端点接入。
 * - "declared"：协议/认证已建模，adapter 未完成真实联网验收，
 *   运行时返回结构化 provider_unavailable，不静默切换平台模型。
 */

export type ProviderProtocol =
  | 'openai_chat'
  | 'openai_responses'
  | 'anthropic_messages'
  | 'google_generative'
  | 'azure_openai'
  | 'bedrock_converse'
  | 'vertex_gemini'
  | 'custom_openai';

export type ProviderAuthType = 'api_key' | 'oauth' | 'aws_iam' | 'service_account' | 'local' | 'none';

export type RuntimeSupport = 'native' | 'openai_compat' | 'declared';

export interface CatalogModel {
  id: string;
  contextLength?: number;
  deprecated?: boolean;
}

export interface ProviderCatalogEntry {
  id: string;
  displayName: string;
  description: string;
  category: 'us' | 'cn' | 'aggregator' | 'cloud' | 'local' | 'gateway';
  protocol: ProviderProtocol;
  authType: ProviderAuthType;
  runtime: RuntimeSupport;
  defaultBaseUrl: string;
  baseUrlOverridable: boolean;
  keyHint: string;
  /** 模型发现方式：models_endpoint = GET {base}/models；manual = 手动填写 */
  modelDiscovery: 'models_endpoint' | 'manual';
  models: CatalogModel[];
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsEmbeddings: boolean;
  supportsReasoning: boolean;
  regions?: string[];
  catalogUpdatedAt: string;
  deprecated?: boolean;
}

const UPDATED = '2026-09-05';

function openAICompat(
  id: string,
  displayName: string,
  category: ProviderCatalogEntry['category'],
  defaultBaseUrl: string,
  models: string[],
  extra: Partial<ProviderCatalogEntry> = {},
): ProviderCatalogEntry {
  return {
    id,
    displayName,
    description: extra.description ?? `${displayName}（OpenAI 兼容端点）`,
    category,
    protocol: 'openai_chat',
    authType: 'api_key',
    runtime: 'openai_compat',
    defaultBaseUrl,
    baseUrlOverridable: true,
    keyHint: 'sk-...',
    modelDiscovery: 'models_endpoint',
    models: models.map((m) => ({ id: m })),
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: false,
    supportsEmbeddings: false,
    supportsReasoning: false,
    catalogUpdatedAt: UPDATED,
    ...extra,
  };
}

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    id: 'openai',
    displayName: 'OpenAI',
    description: 'OpenAI 官方 API（Chat Completions）',
    category: 'us',
    protocol: 'openai_chat',
    authType: 'api_key',
    runtime: 'native',
    defaultBaseUrl: 'https://api.openai.com/v1',
    baseUrlOverridable: true,
    keyHint: 'sk-...',
    modelDiscovery: 'models_endpoint',
    models: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }, { id: 'o4-mini' }],
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: true,
    supportsEmbeddings: true,
    supportsReasoning: true,
    catalogUpdatedAt: UPDATED,
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic Claude',
    description: 'Anthropic Messages API（原生协议）',
    category: 'us',
    protocol: 'anthropic_messages',
    authType: 'api_key',
    runtime: 'native',
    defaultBaseUrl: 'https://api.anthropic.com',
    baseUrlOverridable: true,
    keyHint: 'sk-ant-...',
    modelDiscovery: 'models_endpoint',
    models: [{ id: 'claude-sonnet-4-5' }, { id: 'claude-opus-4-1' }, { id: 'claude-haiku-4-5' }],
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: true,
    supportsEmbeddings: false,
    supportsReasoning: true,
    catalogUpdatedAt: UPDATED,
  },
  openAICompat('gemini', 'Google Gemini / AI Studio', 'us', 'https://generativelanguage.googleapis.com/v1beta/openai', ['gemini-2.5-pro', 'gemini-2.5-flash'], {
    protocol: 'google_generative',
    description: 'Google AI Studio（经官方 OpenAI 兼容端点接入）',
    keyHint: 'AIza...',
    supportsVision: true,
    supportsReasoning: true,
  }),
  {
    id: 'vertex_gemini',
    displayName: 'Google Vertex AI',
    description: 'Vertex AI Gemini（service account；adapter 声明完成，真实验收待凭据）',
    category: 'cloud',
    protocol: 'vertex_gemini',
    authType: 'service_account',
    runtime: 'declared',
    defaultBaseUrl: 'https://{region}-aiplatform.googleapis.com/v1',
    baseUrlOverridable: true,
    keyHint: 'service-account JSON',
    modelDiscovery: 'manual',
    models: [{ id: 'gemini-2.5-pro' }],
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: true,
    supportsEmbeddings: true,
    supportsReasoning: true,
    regions: ['us-central1', 'europe-west4', 'asia-east1'],
    catalogUpdatedAt: UPDATED,
  },
  {
    id: 'azure_openai',
    displayName: 'Azure OpenAI / AI Foundry',
    description: 'Azure OpenAI（api-key 认证，deployment 作为 model；adapter 声明完成，真实验收待凭据）',
    category: 'cloud',
    protocol: 'azure_openai',
    authType: 'api_key',
    runtime: 'declared',
    defaultBaseUrl: 'https://{resource}.openai.azure.com/openai/deployments/{deployment}',
    baseUrlOverridable: true,
    keyHint: 'Azure API key',
    modelDiscovery: 'manual',
    models: [{ id: 'gpt-4o' }],
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: true,
    supportsEmbeddings: true,
    supportsReasoning: false,
    regions: ['eastus', 'westeurope', 'southeastasia'],
    catalogUpdatedAt: UPDATED,
  },
  {
    id: 'bedrock',
    displayName: 'AWS Bedrock',
    description: 'Bedrock Converse API（AWS IAM 签名；adapter 声明完成，真实验收待凭据）',
    category: 'cloud',
    protocol: 'bedrock_converse',
    authType: 'aws_iam',
    runtime: 'declared',
    defaultBaseUrl: 'https://bedrock-runtime.{region}.amazonaws.com',
    baseUrlOverridable: true,
    keyHint: 'AWS access key',
    modelDiscovery: 'manual',
    models: [{ id: 'anthropic.claude-sonnet-4-5' }],
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: true,
    supportsEmbeddings: true,
    supportsReasoning: true,
    regions: ['us-east-1', 'us-west-2', 'eu-west-1'],
    catalogUpdatedAt: UPDATED,
  },
  openAICompat('xai', 'xAI / Grok', 'us', 'https://api.x.ai/v1', ['grok-3', 'grok-3-mini'], {
    keyHint: 'xai-...',
    supportsReasoning: true,
  }),
  openAICompat('deepseek', 'DeepSeek', 'cn', 'https://api.deepseek.com/v1', ['deepseek-chat', 'deepseek-reasoner'], {
    supportsReasoning: true,
  }),
  openAICompat('moonshot', 'Moonshot / Kimi（国际区）', 'cn', 'https://api.moonshot.ai/v1', ['kimi-k2-0905-preview', 'moonshot-v1-32k'], {}),
  openAICompat('moonshot_cn', 'Moonshot / Kimi（中国区）', 'cn', 'https://api.moonshot.cn/v1', ['kimi-k2-0905-preview', 'moonshot-v1-32k'], {}),
  openAICompat('qwen', 'Qwen / DashScope', 'cn', 'https://dashscope.aliyuncs.com/compatible-mode/v1', ['qwen-max', 'qwen-plus'], {
    supportsVision: true,
  }),
  openAICompat('glm', '智谱 GLM', 'cn', 'https://open.bigmodel.cn/api/paas/v4', ['glm-4.7', 'glm-4.5-air'], {
    supportsReasoning: true,
  }),
  openAICompat('doubao', '豆包 / 火山引擎', 'cn', 'https://ark.cn-beijing.volces.com/api/v3', ['doubao-seed-1-6-250615', 'doubao-seed-1-6-flash-250615'], {
    supportsVision: true,
    supportsReasoning: true,
  }),
  openAICompat('minimax', 'MiniMax', 'cn', 'https://api.minimax.chat/v1', ['MiniMax-M1', 'abab6.5s-chat'], {
    supportsReasoning: true,
  }),
  openAICompat('mistral', 'Mistral', 'us', 'https://api.mistral.ai/v1', ['mistral-large-latest', 'mistral-small-latest'], {
    keyHint: '...',
    supportsEmbeddings: true,
  }),
  openAICompat('cohere', 'Cohere', 'us', 'https://api.cohere.com/compatibility/v1', ['command-r-plus', 'command-r'], {
    description: 'Cohere（经官方 OpenAI 兼容端点接入）',
    supportsEmbeddings: true,
  }),
  openAICompat('groq', 'Groq', 'us', 'https://api.groq.com/openai/v1', ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768'], {}),
  openAICompat('together', 'Together', 'us', 'https://api.together.xyz/v1', ['meta-llama/Llama-3.3-70B-Instruct-Turbo'], {
    supportsEmbeddings: true,
  }),
  openAICompat('fireworks', 'Fireworks', 'us', 'https://api.fireworks.ai/inference/v1', ['accounts/fireworks/models/llama-v3p3-70b-instruct'], {}),
  openAICompat('openrouter', 'OpenRouter', 'aggregator', 'https://openrouter.ai/api/v1', ['openai/gpt-4o', 'anthropic/claude-sonnet-4-5'], {
    description: 'OpenRouter 聚合网关',
  }),
  openAICompat('siliconflow', 'SiliconFlow', 'cn', 'https://api.siliconflow.cn/v1', ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'], {
    supportsEmbeddings: true,
  }),
  openAICompat('novita', 'Novita', 'aggregator', 'https://api.novita.ai/v3/openai', ['deepseek/deepseek-v3-0324'], {}),
  openAICompat('nvidia_nim', 'NVIDIA NIM', 'us', 'https://integrate.api.nvidia.com/v1', ['nvidia/llama-3.1-nemotron-70b-instruct'], {}),
  openAICompat('vercel_gateway', 'Vercel AI Gateway', 'gateway', 'https://ai-gateway.vercel.sh/v1', ['openai/gpt-4o'], {
    description: 'Vercel AI Gateway 聚合网关',
  }),
  openAICompat('ollama', 'Ollama（本地）', 'local', 'http://localhost:11434/v1', ['llama3.1', 'qwen2.5'], {
    authType: 'local',
    keyHint: '可为空（本地服务）',
    description: '本地 Ollama 服务（OpenAI 兼容端点）',
  }),
  openAICompat('lm_studio', 'LM Studio（本地）', 'local', 'http://localhost:1234/v1', [], {
    authType: 'local',
    keyHint: '可为空（本地服务）',
    modelDiscovery: 'models_endpoint',
    description: '本地 LM Studio 服务（OpenAI 兼容端点）',
  }),
  openAICompat('vllm', 'vLLM（自托管）', 'local', 'http://localhost:8000/v1', [], {
    authType: 'local',
    keyHint: '按部署配置',
    description: '自托管 vLLM 推理服务（OpenAI 兼容端点）',
  }),
  openAICompat('litellm', 'LiteLLM 网关', 'gateway', 'http://localhost:4000/v1', [], {
    authType: 'api_key',
    description: 'LiteLLM 代理网关（OpenAI 兼容端点）',
  }),
  {
    id: 'custom',
    displayName: '自定义（任意 OpenAI 兼容端点）',
    description: '任何实现了 OpenAI Chat Completions 协议的端点',
    category: 'local',
    protocol: 'custom_openai',
    authType: 'api_key',
    runtime: 'native',
    defaultBaseUrl: '',
    baseUrlOverridable: true,
    keyHint: 'sk-...',
    modelDiscovery: 'manual',
    models: [],
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: false,
    supportsEmbeddings: false,
    supportsReasoning: false,
    catalogUpdatedAt: UPDATED,
  },
];

const catalogIndex = new Map(PROVIDER_CATALOG.map((entry) => [entry.id, entry]));

export function getCatalogEntry(id: string): ProviderCatalogEntry | undefined {
  return catalogIndex.get(id);
}

/** 连接测试/运行时所需的协议归一：declared 协议无可用 adapter 时返回 null。 */
export function runtimeProtocolOf(entry: ProviderCatalogEntry): 'openai' | 'anthropic' | null {
  if (entry.runtime === 'declared') return null;
  if (entry.protocol === 'anthropic_messages') return 'anthropic';
  return 'openai';
}

/** 目录序列化（供设置页 / API 使用；不包含任何秘密） */
export function catalogSummary() {
  return PROVIDER_CATALOG.map((entry) => ({
    id: entry.id,
    displayName: entry.displayName,
    description: entry.description,
    category: entry.category,
    protocol: entry.protocol,
    authType: entry.authType,
    runtime: entry.runtime,
    defaultBaseUrl: entry.defaultBaseUrl,
    baseUrlOverridable: entry.baseUrlOverridable,
    keyHint: entry.keyHint,
    modelDiscovery: entry.modelDiscovery,
    models: entry.models,
    capabilities: {
      streaming: entry.supportsStreaming,
      tools: entry.supportsTools,
      vision: entry.supportsVision,
      embeddings: entry.supportsEmbeddings,
      reasoning: entry.supportsReasoning,
    },
    regions: entry.regions ?? [],
    catalogUpdatedAt: entry.catalogUpdatedAt,
    deprecated: entry.deprecated ?? false,
  }));
}
