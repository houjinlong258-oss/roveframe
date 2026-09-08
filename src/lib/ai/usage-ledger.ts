/**
 * AI usage ledger —— 最小可用的用量/成本记录。
 *
 * 记录 tenant / business / agent / provider / model / tokens /
 * estimated cost / status / correlation id / created_at。
 * 无法从 provider 得到真实 token 时允许为空，绝不伪造精确成本。
 *
 * 表不存在（迁移未执行）时降级为内存环形缓冲，不阻断主链路；
 * 该降级只用于本地/测试，部署门禁应在迁移缺失时显式失败。
 */

import { getSupabaseClient } from '@/storage/database/supabase-client';

export interface AIUsageEntry {
  tenantId: string | null;
  businessId?: string | null;
  userId?: string | null;
  agent?: string | null; // capability 或 agent 类型
  provider: string; // "platform" 或 catalog id
  model: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  estimatedCostUsd?: number | null; // 仅在目录有已知价格时填写，否则 null
  status: 'ok' | 'error' | 'fallback';
  errorCode?: string | null;
  correlationId: string;
  latencyMs?: number | null;
}

const MEMORY_LIMIT = 500;
const memoryLedger: Array<AIUsageEntry & { createdAt: string }> = [];

let dbUnavailable = false;

export async function recordAIUsage(entry: AIUsageEntry): Promise<void> {
  const row = {
    tenant_id: entry.tenantId,
    business_id: entry.businessId ?? null,
    user_id: entry.userId ?? null,
    agent: entry.agent ?? null,
    provider: entry.provider,
    model: entry.model,
    input_tokens: entry.inputTokens ?? null,
    output_tokens: entry.outputTokens ?? null,
    estimated_cost_usd: entry.estimatedCostUsd ?? null,
    status: entry.status,
    error_code: entry.errorCode ?? null,
    correlation_id: entry.correlationId,
    latency_ms: entry.latencyMs ?? null,
  };

  if (!dbUnavailable) {
    try {
      const client = getSupabaseClient();
      const { error } = await client.from('ai_usage_ledger').insert(row);
      if (!error) return;
      dbUnavailable = true;
    } catch {
      dbUnavailable = true;
    }
  }

  memoryLedger.push({ ...entry, createdAt: new Date().toISOString() });
  if (memoryLedger.length > MEMORY_LIMIT) memoryLedger.splice(0, memoryLedger.length - MEMORY_LIMIT);
}

/** 测试与降级诊断用：读取内存缓冲中的记录。 */
export function readMemoryLedger(): Array<AIUsageEntry & { createdAt: string }> {
  return [...memoryLedger];
}

export function clearMemoryLedger(): void {
  memoryLedger.length = 0;
  dbUnavailable = false;
}
