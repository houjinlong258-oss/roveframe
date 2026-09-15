/**
 * 推理强度（Reasoning Effort）—— **纯模块，零依赖**。
 *
 * 为什么单独成文件：服务端与浏览器端都要用这套枚举/默认值，
 * 而 `model-registry.ts` 依赖 supabase 客户端（会连带 `child_process`/`fs`），
 * 客户端组件绝不能运行时导入它。任何需要在浏览器里用的常量/纯函数
 * 都必须放在这里，由 model-registry 再导出给服务端使用。
 */

export type ReasoningLevel = 'low' | 'medium' | 'high';

/**
 * Composer 传下来的模型偏好（三件都可选；缺省即沿用服务端 model_assign 分配）。
 */
export interface ModelPreference {
  provider?: string | null;
  model?: string | null;
  reasoning?: ReasoningLevel | null;
}

/** 推理强度档位：影响 max_tokens / temperature / system 指令，不伪造 provider 私有参数。 */
export interface ReasoningProfile {
  level: ReasoningLevel;
  label: string;
  description: string;
  maxTokens: number;
  temperature: number;
  systemDirective: string;
}

export const REASONING_LEVELS: Record<ReasoningLevel, ReasoningProfile> = {
  low: {
    level: 'low',
    label: 'Low',
    description: 'Quick answers, short replies',
    maxTokens: 1_200,
    temperature: 0.4,
    systemDirective: 'Be concise. Lead with the conclusion, keep detail minimal.',
  },
  medium: {
    level: 'medium',
    label: 'Medium',
    description: 'Everyday operations analysis',
    maxTokens: 2_600,
    temperature: 0.6,
    systemDirective: 'Give a brief reasoning line before the conclusion, then actionable detail.',
  },
  high: {
    level: 'high',
    label: 'High',
    description: 'Strategy and complex multi-step tasks',
    maxTokens: 4_096,
    temperature: 0.3,
    systemDirective:
      'Reason step by step before answering. Show the analysis chain, trade-offs and risks, then a prioritised recommendation.',
  },
};

const REASONING_LEVEL_KEYS: ReadonlySet<string> = new Set(['low', 'medium', 'high']);

/** 校验并归一化客户端传入的推理强度（缺省 medium）。 */
export function resolveReasoningLevel(value: unknown): ReasoningLevel {
  return typeof value === 'string' && REASONING_LEVEL_KEYS.has(value)
    ? (value as ReasoningLevel)
    : 'medium';
}

/** 每个 AI 员工（persona/agent 角色）的默认推理强度。用户始终可以手动覆盖。 */
export const AGENT_DEFAULT_REASONING: Record<string, ReasoningLevel> = {
  ceo: 'high',
  'ceo-insight': 'high',
  operations: 'medium',
  coo: 'medium',
  marketing: 'medium',
  cmo: 'medium',
  customer: 'medium',
  developer: 'high',
  devops: 'high',
  cto: 'high',
};

export function defaultReasoningForAgent(agentKey: string | null | undefined): ReasoningLevel {
  if (!agentKey) return 'medium';
  return AGENT_DEFAULT_REASONING[agentKey] ?? 'medium';
}
