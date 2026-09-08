import { NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { adminHandler } from '@/lib/admin-api';

/**
 * GET /api/admin/overview — 平台总览：商户数、订阅状态分布、AI 用量概览、即将到期。
 * 只返回聚合数字与掩码状态，不返回任何商户秘密。
 */
export async function GET(request: Request) {
  return adminHandler(request, { action: 'admin.overview.read' }, async () => {
    const client = getSupabaseClient();

    const [tenants, subscriptions, usage, audit] = await Promise.all([
      client.from('tenants').select('id', { count: 'exact', head: true }),
      client.from('tenant_subscriptions').select('tenant_id, status, current_period_end, grace_period_end'),
      client.from('ai_usage_ledger').select('provider, model, status, input_tokens, output_tokens, created_at').order('created_at', { ascending: false }).limit(500),
      client.from('platform_admin_audit_logs').select('id', { count: 'exact', head: true }),
    ]);

    const subs = (subscriptions.data ?? []) as Array<{ status: string; current_period_end: string | null; grace_period_end: string | null }>;
    const byStatus: Record<string, number> = {};
    const now = Date.now();
    const in14d = now + 14 * 86400_000;
    let expiringSoon = 0;
    for (const sub of subs) {
      byStatus[sub.status] = (byStatus[sub.status] ?? 0) + 1;
      const end = sub.current_period_end ? new Date(sub.current_period_end).getTime() : null;
      if (end && end > now && end < in14d) expiringSoon += 1;
    }

    const usageRows = (usage.data ?? []) as Array<{ provider: string; status: string; input_tokens: number | null; output_tokens: number | null }>;
    const usageByProvider: Record<string, { calls: number; errors: number; inputTokens: number; outputTokens: number }> = {};
    for (const row of usageRows) {
      const bucket = (usageByProvider[row.provider] ??= { calls: 0, errors: 0, inputTokens: 0, outputTokens: 0 });
      bucket.calls += 1;
      if (row.status === 'error') bucket.errors += 1;
      bucket.inputTokens += row.input_tokens ?? 0;
      bucket.outputTokens += row.output_tokens ?? 0;
    }

    return NextResponse.json({
      tenantCount: tenants.count ?? 0,
      subscriptionsByStatus: byStatus,
      expiringSoon,
      aiUsageByProvider: usageByProvider,
      platformAuditCount: audit.count ?? 0,
    });
  });
}
