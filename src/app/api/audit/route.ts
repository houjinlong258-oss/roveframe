import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requireBusinessContext } from '@/lib/tenant';
import { getSupabaseClient } from '@/storage/database/supabase-client';

/**
 * Production Audit Store 查询：audit_events（tenant/business 双 scope）。
 * 支持按 approval_id / action / status 过滤与分页。
 */
export async function GET(request: NextRequest) {
  try {
    const context = requireBusinessContext(await getTenantContext(request));
    const { searchParams } = new URL(request.url);
    const approvalId = searchParams.get('approval_id') ?? undefined;
    const action = searchParams.get('action') ?? undefined;
    const status = searchParams.get('status') ?? undefined;
    const limit = Math.max(1, Math.min(100, Number(searchParams.get('limit') ?? '50') || 50));
    const offset = Math.max(0, Number(searchParams.get('offset') ?? '0') || 0);

    let query = getSupabaseClient().from('audit_events')
      .select('*', { count: 'exact' })
      .eq('tenant_id', context.tenantId)
      .eq('business_id', context.businessId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (approvalId) query = query.eq('approval_id', approvalId);
    if (action) query = query.eq('action', action);
    if (status) query = query.eq('status', status);

    const { data, error, count } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ events: data ?? [], total: count ?? 0, limit, offset });
  } catch (authError) {
    const message = authError instanceof Error ? authError.message : String(authError);
    if (message.includes('uthenticat') || message.includes('session')) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
