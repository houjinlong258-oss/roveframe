/**
 * 图像生成 —— 走服务商原生的 OpenAI 兼容 `/images/generations`。
 *
 * 背景：老板说「生成一张营销海报」，模型不能回「我无法生成图片」——
 * 那是运行时该回答的问题。这里负责真正的出图，失败时给出**可执行**的原因
 * （没接入图像模型 / 上游拒绝 / 超时），而不是含糊其辞。
 *
 * 与聊天模型严格分离：只有 `classifyModelCapability(model) === 'image'` 的模型
 * 才会被选来出图。反过来，图像模型永远不会被当作聊天模型调用。
 */

import { getSupabaseClient } from '@/storage/database/supabase-client';
import { decrypt } from '@/lib/crypto';
import { getCatalogEntry } from '@/lib/ai/provider-catalog';
import { PROVIDER_PRESETS } from '@/lib/ai/providers';
import { joinEndpoint, checkBaseUrl } from '@/lib/ai/url-utils';
import { assertSafeOutboundUrl, fetchWithOutboundGuard } from '@/lib/security/outbound-url';
import { classifyModelCapability, type ModelRegistry } from '@/lib/ai/model-registry';
import type { AIRequestScope } from '@/lib/ai/router';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export interface ImageCandidate {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  allowLocal: boolean;
}

export type ImageGenerationResult =
  | { ok: true; data: Buffer; mime: string; provider: string; model: string }
  | { ok: false; reason: 'no_image_model' | 'config_invalid' | 'upstream_error' | 'empty_response'; message: string };

/** 从注册表里挑出第一家有「图像模型 + 可用凭据」的服务商 */
export async function pickImageCandidate(
  registry: ModelRegistry,
  scope: AIRequestScope | null,
): Promise<ImageCandidate | null> {
  if (!scope?.tenantId || !scope.businessId) return null;
  const client = getSupabaseClient();

  for (const provider of registry.providers) {
    const imageModels = provider.models.filter((model) => model.capability === 'image');
    if (imageModels.length === 0) continue;
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

    const preferred = provider.defaultModel
      && classifyModelCapability(provider.defaultModel) === 'image'
      ? provider.defaultModel
      : imageModels[0].id;

    return {
      provider: provider.id,
      model: preferred,
      baseUrl,
      apiKey: row.api_key_encrypted ? decrypt(row.api_key_encrypted) : '',
      allowLocal,
    };
  }
  return null;
}

interface ImagePayload {
  data?: Array<{ b64_json?: string; url?: string }>;
}

/** 出图。任何失败都返回结构化原因，不抛错。 */
export async function generateImage(
  prompt: string,
  registry: ModelRegistry,
  scope: AIRequestScope | null,
  options: { size?: string } = {},
): Promise<ImageGenerationResult> {
  const candidate = await pickImageCandidate(registry, scope);
  if (!candidate) {
    return {
      ok: false,
      reason: 'no_image_model',
      message:
        'No image-capable model is connected. Add one in Settings → AI Providers '
        + '(a model whose id contains "image", e.g. agnes-image-2.0-flash).',
    };
  }

  try {
    const url = joinEndpoint(candidate.baseUrl, 'images/generations');
    const response = await fetchWithOutboundGuard(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${candidate.apiKey}`,
        },
        body: JSON.stringify({
          model: candidate.model,
          prompt,
          n: 1,
          size: options.size ?? '1024x1024',
          response_format: 'b64_json',
        }),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      },
      candidate.allowLocal ? { allowHttp: true, allowPrivate: true } : {},
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        ok: false,
        reason: 'upstream_error',
        message: `${candidate.provider} ${response.status}: ${body.slice(0, 300)}`,
      };
    }

    const payload = (await response.json()) as ImagePayload;
    const first = payload.data?.[0];
    if (first?.b64_json) {
      const data = Buffer.from(first.b64_json, 'base64');
      if (data.length === 0) {
        return { ok: false, reason: 'empty_response', message: 'upstream returned an empty image' };
      }
      return {
        ok: true,
        data,
        mime: sniffImageMime(data),
        provider: candidate.provider,
        model: candidate.model,
      };
    }

    if (first?.url) {
      // 有些兼容端点只给 URL：同样要走 SSRF 守卫再取回
      const safeUrl = await assertSafeOutboundUrl(first.url, {});
      const imageResponse = await fetchWithOutboundGuard(
        safeUrl,
        { signal: AbortSignal.timeout(30_000) },
        {},
      );
      if (!imageResponse.ok) {
        return { ok: false, reason: 'upstream_error', message: `image download ${imageResponse.status}` };
      }
      const buffer = Buffer.from(await imageResponse.arrayBuffer());
      if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
        return { ok: false, reason: 'empty_response', message: 'downloaded image size out of range' };
      }
      return {
        ok: true,
        data: buffer,
        mime: sniffImageMime(buffer),
        provider: candidate.provider,
        model: candidate.model,
      };
    }

    return { ok: false, reason: 'empty_response', message: 'upstream returned no image data' };
  } catch (error) {
    return {
      ok: false,
      reason: 'upstream_error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 按文件头判断真实图片类型（不信任上游给的 content-type） */
export function sniffImageMime(data: Buffer): string {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (data.length >= 6 && data.toString('ascii', 0, 3) === 'GIF') {
    return 'image/gif';
  }
  return 'image/png';
}

/** mime → 文件扩展名 */
export function extensionForMime(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return 'png';
  }
}
