/**
 * 视频生成 —— 走服务商原生的 OpenAI 兼容 `/videos` 异步任务接口。
 *
 * ## 为什么在 TS 侧做，而不是复用运行时的视频工具
 *
 * 运行时的 `video_generate` 工具把成片存在**运行时自己的磁盘**上
 * （`…/roveagent/cache/videos/*.mp4`），而 App 的产物系统（文件中心）在 web 进程里，
 * docker 部署下还是另一个容器 —— 拿不到那个路径。本仓库的既有先例是：
 * **图片生成走 TS 侧**（`image-generation.ts` → 直接 `putArtifact` 进文件中心），
 * 运行时另有自己的图片插件。视频照同一模式做，才能把成片落进文件中心，
 * 也不新增重复架构（TS 侧图片生成与运行时图片插件本就并存）。
 *
 * ## 协议（实测确认，2026-09-25）
 *
 * 目标是 OpenAI Videos 异步任务形状，但 LiteLLM 风格的聚合网关多一个必填的
 * `mode` 字段，且**输出地址在任务对象的顶层 `url`**（不是 OpenAI 的 `data[].url`），
 * 并且**没有**实现 `GET /videos/{id}/content`（实测 502 + HTML）：
 *
 *     POST {base}/videos {"mode":"ti2vid","model":"agnes-video-v2.0","prompt":"…"}
 *     -> 200 {"id":"task_…","status":"queued","progress":0}
 *     GET  {base}/videos/{id}
 *     -> {"status":"completed","progress":100,"perf_output_size":2373927,
 *         "url":"https://platform-outputs.agnes-ai.space/videos/…/video_….mp4"}
 *
 * 与聊天模型严格分离：只有 `classifyModelCapability(model) === 'video'` 的模型
 * 才会被选来出片。
 */

import { getSupabaseClient } from '@/storage/database/supabase-client';
import { decrypt } from '@/lib/crypto';
import { getCatalogEntry } from '@/lib/ai/provider-catalog';
import { PROVIDER_PRESETS } from '@/lib/ai/providers';
import { joinEndpoint, checkBaseUrl } from '@/lib/ai/url-utils';
import { assertSafeOutboundUrl, fetchWithOutboundGuard } from '@/lib/security/outbound-url';
import type { ModelRegistry } from '@/lib/ai/model-registry';
import type { AIRequestScope } from '@/lib/ai/router';

/** 单次 HTTP 的超时（提交/轮询各算一次，不覆盖整个任务周期） */
const REQUEST_TIMEOUT_MS = 60_000;
/** 任务总时限：实测一次 5 秒 1088x832 的成片推理约 84 秒，给足余量 */
const JOB_DEADLINE_MS = 15 * 60 * 1000;
/** 轮询间隔 */
const POLL_INTERVAL_MS = 5_000;
/** 成片大小上限（20MB，与产物桶上限一致） */
const MAX_VIDEO_BYTES = 20 * 1024 * 1024;

/**
 * LiteLLM 风格网关要求的任务模式，默认 `ti2vid`（文/图生视频）。
 * 设为空字符串则不发该字段 —— 对接严格的 OpenAI 官方端点时用得上。
 */
function videoMode(): string {
  const raw = process.env.ROVEAGENT_VIDEO_MODE;
  return (raw === undefined ? 'ti2vid' : raw).trim();
}

export interface VideoCandidate {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  allowLocal: boolean;
}

export type VideoGenerationResult =
  | { ok: true; data: Buffer; mime: string; provider: string; model: string; skipped?: string[] }
  | {
      ok: false;
      reason: 'no_video_model' | 'config_invalid' | 'upstream_error' | 'job_failed' | 'timeout' | 'empty_response';
      message: string;
      /** 换过的候选（用于把"为什么不直接用第一个"如实告诉用户） */
      skipped?: string[];
    };

/**
 * 该失败是否属于「这个模型不接受本接口/参数」—— 只有这种才值得换下一个候选。
 *
 * 实测信号：网关回 `{"code":"invalid_request","message":"invalid mode"}`。
 * 其它错误（超时、鉴权、任务失败）换模型也救不了，直接如实返回，不烧额度。
 */
export function isModelMismatch(message: string): boolean {
  return /invalid mode|unsupported|not supported|model_not_found|no such model|does not support/i.test(
    message,
  );
}

/**
 * 挑出所有「视频模型 + 可用凭据」的候选，按尝试顺序返回。
 *
 * ## 为什么要给多个候选（实测）
 *
 * 同一个服务商可以暴露**模式词表互不兼容**的视频模型，而模型清单里看不出区别：
 *
 *   · `agnes-video-v2.0`      + `mode=ti2vid` → 200，任务正常出片
 *   · `agnes-video-2.5-flash` + {ti2vid, t2v, text-to-video} → 全部 400 `invalid mode`
 *
 * 只挑一个的话，目录顺序说了算 —— 顺序一变"出片功能"就坏，而且报错是
 * `invalid mode`，看起来像参数写错了。所以这里返回有序候选，让调用方逐个试，
 * 并把跳过的模型**显式告知**（不是静默 fallback）。
 *
 * 顺序：`ROVEAGENT_VIDEO_MODEL` 指定的排最前（运维可强制），
 * 其次服务商默认模型（仅当它自己是视频模型），最后是目录里的其余视频模型。
 */
export async function pickVideoCandidates(
  registry: ModelRegistry,
  scope: AIRequestScope | null,
): Promise<VideoCandidate[]> {
  if (!scope?.tenantId || !scope.businessId) return [];
  const client = getSupabaseClient();
  const preferred = (process.env.ROVEAGENT_VIDEO_MODEL ?? '').trim();
  const out: VideoCandidate[] = [];

  for (const provider of registry.providers) {
    const videoModels = provider.models.filter((model) => model.capability === 'video');
    if (videoModels.length === 0) continue;
    if (!provider.configured) continue;

    const { data } = await client
      .from('model_configs')
      .select('provider, api_key_encrypted, base_url, is_enabled')
      .eq('tenant_id', scope.tenantId)
      .eq('business_id', scope.businessId)
      .eq('provider', provider.id)
      .eq('is_enabled', true)
      .limit(1);
    const row = (data ?? [])[0] as
      | { api_key_encrypted: string | null; base_url: string | null }
      | undefined;
    if (!row) continue;

    const catalog = getCatalogEntry(provider.id);
    const needsKey = catalog ? catalog.authType === 'api_key' || catalog.authType === 'oauth' : true;
    if (needsKey && !row.api_key_encrypted) continue;

    const baseUrl = row.base_url || catalog?.defaultBaseUrl || PROVIDER_PRESETS[provider.id]?.baseUrl || '';
    const allowLocal = catalog?.category === 'local' || catalog?.authType === 'local';
    if (!checkBaseUrl(baseUrl, { allowLocal }).ok) continue;

    let apiKey = '';
    try {
      apiKey = row.api_key_encrypted ? decrypt(row.api_key_encrypted) : '';
    } catch {
      apiKey = '';
    }
    if (needsKey && !apiKey) continue;

    const ids = videoModels.map((m) => m.id);
    const ordered: string[] = [];
    if (preferred && ids.includes(preferred)) ordered.push(preferred);
    if (
      provider.defaultModel &&
      ids.includes(provider.defaultModel) &&
      !ordered.includes(provider.defaultModel)
    ) {
      ordered.push(provider.defaultModel);
    }
    for (const id of ids) if (!ordered.includes(id)) ordered.push(id);

    for (const model of ordered) {
      out.push({ provider: provider.id, model, baseUrl, apiKey, allowLocal });
    }
  }
  return out;
}

/** 单候选版本（保留给只想知道"能不能出片"的调用方）。 */
export async function pickVideoCandidate(
  registry: ModelRegistry,
  scope: AIRequestScope | null,
): Promise<VideoCandidate | null> {
  const candidates = await pickVideoCandidates(registry, scope);
  return candidates[0] ?? null;
}

/** 从任务对象里取输出地址：顶层 `url` 优先，其次 OpenAI 的 `data[].url`。 */
export function outputUrlOf(job: unknown): string | null {
  if (!job || typeof job !== 'object') return null;
  const record = job as Record<string, unknown>;
  if (typeof record.url === 'string' && record.url) return record.url;
  const data = record.data;
  if (Array.isArray(data)) {
    for (const item of data) {
      if (item && typeof item === 'object') {
        const url = (item as Record<string, unknown>).url;
        if (typeof url === 'string' && url) return url;
      }
    }
  }
  return null;
}

/** 任务是否已到终态；返回 null 表示仍在进行中。 */
export function terminalStatusOf(job: unknown): 'succeeded' | 'failed' | null {
  if (!job || typeof job !== 'object') return null;
  const raw = (job as Record<string, unknown>).status;
  const status = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (status === 'completed' || status === 'succeeded') return 'succeeded';
  if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) return 'failed';
  return null;
}

/** 成片字节的容器嗅探（只认 MP4/WebM 的魔数，不猜）。 */
export function sniffVideoMime(data: Buffer): string {
  if (data.length >= 12 && data.subarray(4, 8).toString('latin1') === 'ftyp') return 'video/mp4';
  if (data.length >= 4 && data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) {
    return 'video/webm';
  }
  return 'application/octet-stream';
}

/**
 * 出片。任何失败都返回结构化原因，不抛错。
 *
 * 流程：提交任务 → 有界轮询到终态 → 取顶层 url → 经 SSRF 守卫下载字节。
 */
export async function generateVideo(
  prompt: string,
  registry: ModelRegistry,
  scope: AIRequestScope | null,
  options: { seconds?: number } = {},
): Promise<VideoGenerationResult> {
  const candidates = await pickVideoCandidates(registry, scope);
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: 'no_video_model',
      message:
        'No video-capable model is connected. Add one in Settings → AI Providers '
        + '(a model whose id contains "video", e.g. agnes-video-v2.0).',
    };
  }

  const skipped: string[] = [];
  for (const candidate of candidates) {
    const result = await attemptVideo(candidate, prompt, options);
    if (result.ok) {
      return skipped.length > 0 ? { ...result, skipped } : result;
    }
    // 只在「该模型不接受本接口/参数」时换下一个；其它错误换模型也救不了。
    if (!isModelMismatch(result.message)) {
      return skipped.length > 0 ? { ...result, skipped } : result;
    }
    skipped.push(`${candidate.model}: ${result.message.slice(0, 160)}`);
  }

  return {
    ok: false,
    reason: 'upstream_error',
    message: `no video model accepted the request; tried ${candidates.length}`,
    skipped,
  };
}

/**
 * 用**指定候选**出一次片：提交任务 → 有界轮询到终态 → 取顶层 url →
 * 经 SSRF 守卫下载字节。任何失败都返回结构化原因，不抛错。
 */
async function attemptVideo(
  candidate: VideoCandidate,
  prompt: string,
  options: { seconds?: number },
): Promise<VideoGenerationResult> {
  const outboundPolicy = candidate.allowLocal ? { allowHttp: true, allowPrivate: true } : {};
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${candidate.apiKey}`,
  };

  try {
    const mode = videoMode();
    const body: Record<string, unknown> = { model: candidate.model, prompt };
    if (mode) body.mode = mode;
    if (options.seconds) body.seconds = String(options.seconds);

    const submit = await fetchWithOutboundGuard(
      joinEndpoint(candidate.baseUrl, 'videos'),
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
      outboundPolicy,
    );
    if (!submit.ok) {
      const text = await submit.text().catch(() => '');
      return {
        ok: false,
        reason: 'upstream_error',
        message: `${candidate.provider} ${submit.status}: ${text.slice(0, 300)}`,
      };
    }

    let job = (await submit.json()) as Record<string, unknown>;
    const jobId = typeof job.id === 'string' ? job.id : typeof job.task_id === 'string' ? job.task_id : '';
    if (!jobId) {
      return { ok: false, reason: 'empty_response', message: 'video job returned no id' };
    }

    // 有界轮询：任务可能跑几分钟，但绝不允许无限等待。
    const deadline = Date.now() + JOB_DEADLINE_MS;
    let terminal = terminalStatusOf(job);
    while (terminal === null) {
      if (Date.now() >= deadline) {
        return {
          ok: false,
          reason: 'timeout',
          message: `video job ${jobId} did not finish within ${Math.round(JOB_DEADLINE_MS / 60000)} min`,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      const poll = await fetchWithOutboundGuard(
        joinEndpoint(candidate.baseUrl, `videos/${jobId}`),
        { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
        outboundPolicy,
      );
      if (!poll.ok) {
        const text = await poll.text().catch(() => '');
        return {
          ok: false,
          reason: 'upstream_error',
          message: `poll ${poll.status}: ${text.slice(0, 200)}`,
        };
      }
      job = (await poll.json()) as Record<string, unknown>;
      terminal = terminalStatusOf(job);
    }

    if (terminal === 'failed') {
      return {
        ok: false,
        reason: 'job_failed',
        message: `video job ${jobId} failed: ${JSON.stringify(job.error ?? job).slice(0, 300)}`,
      };
    }

    const url = outputUrlOf(job);
    if (!url) {
      // 明确的 fail-closed：不猜、不去打可能不存在的 content 路由
      return {
        ok: false,
        reason: 'empty_response',
        message: `video job ${jobId} succeeded but exposed no output url`,
      };
    }

    const safeUrl = await assertSafeOutboundUrl(url, {});
    const download = await fetchWithOutboundGuard(
      safeUrl,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      {},
    );
    if (!download.ok) {
      return { ok: false, reason: 'upstream_error', message: `video download ${download.status}` };
    }
    const buffer = Buffer.from(await download.arrayBuffer());
    if (buffer.length === 0) {
      return { ok: false, reason: 'empty_response', message: 'downloaded video was empty' };
    }
    if (buffer.length > MAX_VIDEO_BYTES) {
      return {
        ok: false,
        reason: 'empty_response',
        message: `video is ${buffer.length} bytes, over the ${MAX_VIDEO_BYTES} cap`,
      };
    }
    return {
      ok: true,
      data: buffer,
      mime: sniffVideoMime(buffer),
      provider: candidate.provider,
      model: candidate.model,
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'upstream_error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
