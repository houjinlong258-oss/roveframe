import { NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { adminHandler } from '@/lib/admin-api';

/**
 * GET /api/admin/usage — AI 用量/成本概览（按 tenant/provider/model 聚合）。
 * 不含任何 prompt 内容或密钥。
 */
export async function GET(request: Request) {
  return adminHandler(request, { action: 'admin.usage.read' }, async () => {
    const url = new URL(request.url);
    const tenantId = url.searchParams.get('tenantId');
    const client = getSupabaseClient();

    let query = client
      .from('ai_usage_ledger')
      .select('tenant_id, provider, model, agent, status, input_tokens, output_tokens, latency_ms, created_at')
      .order('created_at', { ascending: false })
      .limit(1000);
    if (tenantId) query = query.eq('tenant_id', tenantId);
    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const byTenant: Record<string, { calls: number; errors: number; inputTokens: number; outputTokens: number; providers: Record<string, number> }> = {};
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const tid = (row.tenant_id as string) ?? 'platform';
      const bucket = (byTenant[tid] ??= { calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, providers: {} });
      bucket.calls += 1;
      if (row.status === 'error') bucket.errors += 1;
      bucket.inputTokens += (row.input_tokens as number) ?? 0;
      bucket.outputTokens += (row.output_tokens as number) ?? 0;
      const p = row.provider as string;
      bucket.providers[p] = (bucket.providers[p] ?? 0) + 1;
    }

    return NextResponse.json({
      byTenant,
      total: (data ?? []).length,
      // 成本估算需要目录价格数据；当前不伪造精确成本
      costEstimation: 'unavailable_no_pricing_data',
    });
  });
}
