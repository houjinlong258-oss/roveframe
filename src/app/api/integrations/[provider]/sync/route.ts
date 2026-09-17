import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { scopedTable } from '@/lib/tenant-db';
import { mapSquareOrder, sandboxSquareOrders } from '@/lib/connectors/square';
import { syncSquareBusiness } from '@/lib/connectors/square-sync';
import { protectBusinessMutation } from '@/lib/mutation-guard';
import { isKnownProvider, isSyncable } from '@/lib/connectors/capabilities';

const DEMO = process.env.RF_E2E_DEMO === '1' && process.env.COZE_PROJECT_ENV !== 'PROD';

/**
 * POS 同步路由：POST /api/integrations/[provider]/sync
 * square 走共享编排器（orders + products + customers + inventory，游标/水位持久化）；
 * 无凭据时仅当显式 RF_E2E_DEMO=1 且非生产才写沙箱样本（生产 fail-closed 409）。
 *
 * Phase 15：可同步的 provider 取自 `src/lib/connectors/capabilities.ts` —— 与
 * 设置页徽章、`connectIntegration` 的状态写入**同一个事实源**，三处不会再漂移。
 */
async function syncIntegration(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  const ctx = requireBusinessContext(await getTenantContext(request));
  requirePermission(ctx, 'integrations:write');

  if (!isSyncable(provider)) {
    // 明确区分"不认识这个 provider"与"认识但没实现同步" ——
    // 后者是 UI 上会显示为已连接的情况，必须给出可操作的说明。
    return NextResponse.json(
      {
        error: isKnownProvider(provider)
          ? `data sync is not implemented for ${provider}`
          : `sync not implemented for ${provider}`,
        detail: isKnownProvider(provider)
          ? `${provider} connectivity can be verified, but no data is imported from it. `
            + 'Inventory or orders shown for this business come from local data.'
          : undefined,
      },
      { status: 400 },
    );
  }

  // 走到这里 provider 必须是有真实实现的那个。
  // 当前唯一有同步编排器的是 square（syncSquareBusiness），因此本段仍绑定 square；
  // 若将来把别的 provider 标为 syncable，**必须同时**在这里接入它的实现，
  // 否则本路由会对一个新 provider 走进 square 的代码 —— 下面的断言会先拦住它。
  if (provider !== 'square') {
    return NextResponse.json(
      { error: `provider ${provider} is marked syncable but has no sync implementation wired here` },
      { status: 501 },
    );
  }

  const cfgRes = await scopedTable(ctx, 'integration_configs', 'id, config_encrypted')
    .eq('provider', provider).eq('is_enabled', true).maybeSingle();
  if (cfgRes.error) return NextResponse.json({ error: cfgRes.error.message }, { status: 500 });
  const row = cfgRes.data as { id: string; config_encrypted: string | null } | null;

  if (row?.config_encrypted) {
    // syncSquareBusiness 内部负责写 last_sync_at 与水位线 ——
    // 因此"最近同步时间"只会在真的同步过之后出现，保存配置时不会被伪造。
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

  return NextResponse.json({ error: `${provider} not connected` }, { status: 409 });
}

export const POST = protectBusinessMutation(
  { permission: 'integrations:write', action: 'integrations.sync', entity: 'integration_configs' },
  syncIntegration,
);
