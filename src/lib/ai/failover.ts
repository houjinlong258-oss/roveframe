/**
 * RoveFrame Provider Failover Manager —— 模型自动故障切换。
 *
 * 架构（与产品文档一致）：
 *   User Request → AI Router → Provider Health Check（Model Registry）
 *     → Primary Candidate → 失败? → Fallback Queue → Next Provider → Success
 *
 * 三条不可违反的规则：
 * 1. **只在还没有产出任何文本时才能切换。** 一旦向用户吐过字，换服务商会产出
 *    拼接错乱/重复的答案，此时宁可失败也不切换。
 * 2. **候选顺序是可解释的**：用户显式选择 → 企业默认分配 → 按健康度排序的
 *    其他已接入服务商 → 平台内置模型。每一步都会发出事件，UI 必须可见。
 * 3. **全部失败绝不静默**：抛出 AllProvidersFailedError（含每个服务商的
 *    code/message/status/latency），同时落一条 `alerts` 记录作为后台故障日志；
 *    单次失败本身已由 ai_usage_ledger 记账。
 */

import { getSupabaseClient } from '@/storage/database/supabase-client';
import {
  trackUsage,
  resolveExternalModel,
  resolvePlatformModel,
  streamResolvedModel,
  type AICallOptions,
  type AIRequestScope,
  type ChatMessage,
  type ModelResolution,
  type UsageCapture,
} from '@/lib/ai/router';
import { AIError, sanitizeProviderMessage } from '@/lib/ai/errors';
import {
  buildModelRegistry,
  classifyModelCapability,
  rankRoutableProviders,
  resolveReasoningLevel,
  type ModelPreference,
  type ModelRegistry,
} from '@/lib/ai/model-registry';
import type { Capability } from '@/lib/ai/providers';

export type { ModelPreference };

export type CandidateSource = 'user' | 'business_default' | 'auto' | 'platform';

export interface ModelCandidate {
  provider: string;
  model: string;
  label: string;
  kind: 'platform' | 'external';
  source: CandidateSource;
  resolution: ModelResolution;
}

export interface SkippedCandidate {
  provider: string;
  model: string;
  reason: string;
}

export interface ModelChain {
  candidates: ModelCandidate[];
  skipped: SkippedCandidate[];
  registry: ModelRegistry;
}

export interface AttemptRecord {
  provider: string;
  model: string;
  label: string;
  code: string;
  message: string;
  status: number | null;
  latencyMs: number;
}

export type FailoverEvent =
  | {
      type: 'attempt';
      index: number;
      total: number;
      provider: string;
      model: string;
      label: string;
      source: CandidateSource;
    }
  | {
      type: 'switched';
      fromProvider: string;
      fromModel: string;
      toProvider: string;
      toModel: string;
      code: string;
      message: string;
    }
  | { type: 'exhausted'; attempts: AttemptRecord[] }
  | {
      type: 'settled';
      provider: string;
      model: string;
      label: string;
      source: CandidateSource;
      latencyMs: number;
      firstTokenMs: number | null;
      failovers: number;
    };

/** 所有候选服务商都失败：必须让用户看到具体原因，而不是「请求完成」。 */
export class AllProvidersFailedError extends Error {
  readonly attempts: AttemptRecord[];
  readonly capability: Capability;
  readonly requestId: string;

  constructor(attempts: AttemptRecord[], capability: Capability, requestId: string) {
    const summary = attempts.map((a) => `${a.provider}(${a.code})`).join(', ') || 'no provider';
    super(`AI service temporarily unavailable. Tried ${attempts.length} provider(s): ${summary}`);
    this.name = 'AllProvidersFailedError';
    this.attempts = attempts;
    this.capability = capability;
    this.requestId = requestId;
  }

  toEvent() {
    return {
      type: 'all_providers_failed' as const,
      requestId: this.requestId,
      capability: this.capability,
      providersTried: this.attempts.length,
      attempts: this.attempts.map((a) => ({
        provider: a.provider,
        model: a.model,
        code: a.code,
        status: a.status,
        message: a.message,
        latencyMs: a.latencyMs,
      })),
    };
  }
}

function labelOf(provider: string, model: string): string {
  return provider === 'platform' ? `${model} (platform)` : model;
}

/**
 * 构建故障切换候选链。顺序：
 * 1. 用户在 Composer 里显式选择的 provider:model（source=user）
 * 2. settings.model_assign 指定的 provider:model（source=business_default）
 * 3. 其他已接入（启用 + 有 Key + adapter 可路由）的服务商，按健康度/延迟排序（source=auto）
 * 4. 平台内置模型（source=platform，永远最后，永远可用）
 *
 * 去重按 `provider:model`；未接入的服务商进 `skipped` 并说明原因（不静默丢弃）。
 */
export async function resolveModelChain(
  capability: Capability,
  scope: AIRequestScope | null,
  preference?: ModelPreference | null,
): Promise<ModelChain> {
  const registry = await buildModelRegistry(
    scope?.businessId ? { tenantId: scope.tenantId, businessId: scope.businessId } : null,
  );
  const candidates: ModelCandidate[] = [];
  const skipped: SkippedCandidate[] = [];
  const seen = new Set<string>();

  const push = (candidate: ModelCandidate) => {
    const key = `${candidate.provider}:${candidate.model}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  const tryExternal = async (
    provider: string,
    model: string,
    source: CandidateSource,
  ): Promise<boolean> => {
    if (!provider) return false;
    // 图像 / 视频 / 语音 / 向量模型不能被当成聊天模型调用（必然 400，
    // 还会白白触发一次故障切换）。用户 localStorage 里的旧选择也要在这里挡掉。
    if (model && classifyModelCapability(model) !== 'chat') {
      skipped.push({ provider, model, reason: 'not_a_chat_model' });
      return false;
    }
    const resolved = await resolveExternalModel(provider, model, capability, scope);
    if (!resolved) {
      skipped.push({ provider, model, reason: 'not_configured' });
      return false;
    }
    push({
      provider: resolved.diagnostics.provider,
      model: resolved.diagnostics.model,
      label: labelOf(resolved.diagnostics.provider, resolved.diagnostics.model),
      kind: 'external',
      source,
      resolution: resolved,
    });
    return true;
  };

  // 1. 用户显式选择
  if (preference?.provider && preference.provider !== 'platform') {
    await tryExternal(preference.provider, preference.model ?? '', 'user');
  }

  // 2. 企业默认分配（model_assign）
  if (registry.defaultProvider) {
    await tryExternal(registry.defaultProvider, registry.defaultModel ?? '', 'business_default');
  }

  // 3. 其他已接入服务商（按健康度 + p50 延迟排序）
  for (const provider of rankRoutableProviders(registry, capability)) {
    if (provider.health === 'error' || provider.health === 'offline') continue;
    // 只挑聊天模型：服务商的默认模型若被配成图像/视频模型，回退到第一个对话模型
    const chatModels = provider.models.filter((item) => item.capability === 'chat');
    const preferred = provider.defaultModel
      && classifyModelCapability(provider.defaultModel) === 'chat'
      ? provider.defaultModel
      : null;
    const model = preferred ?? chatModels[0]?.id ?? '';
    if (!model) continue;
    await tryExternal(provider.id, model, 'auto');
  }

  // 4. 平台内置兜底
  //
  // Phase 15：平台内置不再"永远可用" —— 它需要凭据（平台注入的
  // COZE_API_TOKEN，或部署方配置的 ROVEFRAME_PLATFORM_LLM_*）。
  // 自部署 compose 两者都没有，于是新注册商家（无 settings 行 ⇒ auto）会落到这里。
  //
  // 不可用时**跳过并记录原因**，与上面 tryExternal 的处理一致：链的职责是
  // 收集全部失败原因并汇报（AllProvidersFailedError），一个不可用的候选
  // 抛错会把其余 provider 的信息一起吞掉。
  const platform = resolvePlatformModel(capability, scope?.requestId);
  if (!platform) {
    skipped.push({ provider: 'platform', model: '', reason: 'not_configured' });
    return { candidates, skipped, registry };
  }
  push({
    provider: 'platform',
    model: platform.diagnostics.model,
    label: labelOf('platform', platform.diagnostics.model),
    kind: 'platform',
    source: 'platform',
    resolution: platform,
  });

  return { candidates, skipped, registry };
}

/** 把「全部失败」写进 alerts，作为后台 Provider failure log。 */
async function recordProviderOutage(
  scope: AIRequestScope | null,
  error: AllProvidersFailedError,
): Promise<void> {
  if (!scope?.tenantId || !scope.businessId) return;
  try {
    await getSupabaseClient().from('alerts').insert({
      tenant_id: scope.tenantId,
      business_id: scope.businessId,
      type: 'system',
      level: 'error',
      title: 'AI service unavailable',
      content: [
        `All ${error.attempts.length} provider(s) failed for capability "${error.capability}".`,
        ...error.attempts.map(
          (a) => `- ${a.provider} / ${a.model}: ${a.code}${a.status ? ` (HTTP ${a.status})` : ''} — ${a.message}`,
        ),
        `requestId: ${error.requestId}`,
      ].join('\n'),
    });
  } catch {
    // 故障日志写不进去也不能影响主链路（错误已经抛给调用方）
  }
}

function attemptOf(
  candidate: ModelCandidate,
  err: unknown,
  latencyMs: number,
): AttemptRecord {
  if (err instanceof AIError) {
    return {
      provider: candidate.provider,
      model: candidate.model,
      label: candidate.label,
      code: err.code,
      message: sanitizeProviderMessage(err.message),
      status: err.status ?? null,
      latencyMs,
    };
  }
  return {
    provider: candidate.provider,
    model: candidate.model,
    label: candidate.label,
    code: 'provider_error',
    message: sanitizeProviderMessage(err instanceof Error ? err.message : String(err)),
    status: null,
    latencyMs,
  };
}

export interface FailoverOptions extends AICallOptions {
  preference?: ModelPreference | null;
  onEvent?: (event: FailoverEvent) => void;
  /** 复用调用方已构建的注册表（避免同一请求内重复查询） */
  chain?: ModelChain;
}

/**
 * 带故障切换的流式对话。
 * 每次尝试都会写 ai_usage_ledger（成功=ok，失败=error），因此 Model Status
 * Dashboard 的延迟/失败率来自真实调用，而不是本地猜测。
 */
export async function* streamChatWithFailover(
  capability: Capability,
  messages: ChatMessage[],
  forwardHeaders: Record<string, string> | undefined,
  scope: AIRequestScope | null,
  opts?: FailoverOptions,
): AsyncGenerator<string> {
  const requestId = scope?.requestId ?? crypto.randomUUID();
  const chain = opts?.chain ?? (await resolveModelChain(capability, scope, opts?.preference));
  const callOpts: AICallOptions = {
    ...opts,
    reasoning: resolveReasoningLevel(opts?.reasoning ?? opts?.preference?.reasoning),
  };
  const attempts: AttemptRecord[] = [];
  const total = chain.candidates.length;

  for (let index = 0; index < total; index += 1) {
    const candidate = chain.candidates[index];
    opts?.onEvent?.({
      type: 'attempt',
      index,
      total,
      provider: candidate.provider,
      model: candidate.model,
      label: candidate.label,
      source: candidate.source,
    });

    const startedAt = Date.now();
    const usage: UsageCapture = { inputTokens: null, outputTokens: null };
    let emitted = false;
    let firstTokenMs: number | null = null;

    try {
      for await (const chunk of streamResolvedModel(
        candidate.resolution.resolved,
        messages,
        forwardHeaders,
        candidate.resolution.diagnostics.requestId,
        usage,
        callOpts,
      )) {
        if (!emitted) {
          emitted = true;
          firstTokenMs = Date.now() - startedAt;
        }
        yield chunk;
      }
      await trackUsage(
        candidate.resolution.diagnostics,
        scope,
        callOpts,
        startedAt,
        'ok',
        usage,
        null,
      );
      opts?.onEvent?.({
        type: 'settled',
        provider: candidate.provider,
        model: candidate.model,
        label: candidate.label,
        source: candidate.source,
        latencyMs: Date.now() - startedAt,
        firstTokenMs,
        failovers: attempts.length,
      });
      return;
    } catch (err) {
      const record = attemptOf(candidate, err, Date.now() - startedAt);
      attempts.push(record);
      await trackUsage(
        candidate.resolution.diagnostics,
        scope,
        callOpts,
        startedAt,
        'error',
        usage,
        record.code,
      );

      // 已产出文本：切换会造成答案错乱，宁可失败
      if (emitted) {
        const error = new AllProvidersFailedError(attempts, capability, requestId);
        await recordProviderOutage(scope, error);
        opts?.onEvent?.({ type: 'exhausted', attempts });
        throw error;
      }

      const next = chain.candidates[index + 1];
      if (!next) {
        const error = new AllProvidersFailedError(attempts, capability, requestId);
        await recordProviderOutage(scope, error);
        opts?.onEvent?.({ type: 'exhausted', attempts });
        throw error;
      }

      opts?.onEvent?.({
        type: 'switched',
        fromProvider: candidate.provider,
        fromModel: candidate.model,
        toProvider: next.provider,
        toModel: next.model,
        code: record.code,
        message: record.message,
      });
    }
  }

  const error = new AllProvidersFailedError(attempts, capability, requestId);
  await recordProviderOutage(scope, error);
  opts?.onEvent?.({ type: 'exhausted', attempts });
  throw error;
}
