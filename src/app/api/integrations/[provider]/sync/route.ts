import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { scopedTable } from '@/lib/tenant-db';
import { mapSquareOrder, sandboxSquareOrders } from '@/lib/connectors/square';
import { syncSquareBusiness } from '@/lib/connectors/square-sync';
import { protectBusinessMutation } from '@/lib/mutation-guard';

const DEMO = process.env.RF_E2E_DEMO === '1' && process.env.COZE_PROJECT_ENV !== 'PROD';

/**
 * POS 同步路由：POST /api/integrations/[provider]/sync
 * square 走共享编排器（orders + products + customers + inventory，游标/水位持久化）；
 * 无凭据时仅当显式 RF_E2E_DEMO=1 且非生产才写沙箱样本（生产 fail-closed 409）。
 */
async function syncIntegration(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  const ctx = requireBusinessContext(await getTenantContext(request));
  requirePermission(ctx, 'integrations:write');

  if (provider !== 'square') {
    return NextResponse.json({ error: `sync not implemented for ${provider}` }, { status: 400 });
  }

  const cfgRes = await scopedTable(ctx, 'integration_configs', 'id, config_encrypted')
    .eq('provider', 'square').eq('is_enabled', true).maybeSingle();
  if (cfgRes.error) return NextResponse.json({ error: cfgRes.error.message }, { status: 500 });
  const row = cfgRes.data as { id: string; config_encrypted: string | null } | null;

  if (row?.config_encrypted) {
    const summary = await syncSquareBusiness(ctx.tenantId, ctx.businessId);
    return NextResponse.json({ provider, ...summary });
  }

  if (DEMO) {
    // 演示模式（显式开启且非生产）：沙箱订单写真实库，验证订单闭环。
    const supabase = getSupabaseClient();
    let synced = 0;
    const errors: string[] = [];
    for (const o of sandboxSquareOrders()) {
      const mapped = mapSquareOrder(o);
      const write = await supabase.from('orders').upsert({
        tenant_id: ctx.tenantId,
        business_id: ctx.businessId,
        ...mapped,
        channel: 'dine_in',
        source: 'square',
      }, { onConflict: 'tenant_id,business_id,source,external_id' });
      if (write.error) { errors.push(write.error.message); continue; }
      synced += 1;
    }
    return NextResponse.json({ ok: errors.length === 0, provider, synced, total: 2, errors });
  }

  return NextResponse.json({ error: 'square not connected' }, { status: 409 });
}

export const POST = protectBusinessMutation(
  { permission: 'integrations:write', action: 'integrations.sync', entity: 'integration_configs' },
  syncIntegration,
);
