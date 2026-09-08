import { NextRequest, NextResponse } from 'next/server';
import { decrypt } from '@/lib/crypto';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { scopedTable, updateWithScope } from '@/lib/tenant-db';
import {
  fetchSquareOrders, mapSquareOrder, sandboxSquareOrders, type SquareOrder,
} from '@/lib/connectors/square';
import { protectBusinessMutation } from '@/lib/mutation-guard';

const DEMO = process.env.RF_E2E_DEMO === '1' && process.env.COZE_PROJECT_ENV !== 'PROD';

/**
 * POS 同步路由（缺口 A1/A2 最小闭环）。
 * POST /api/integrations/[provider]/sync
 * 当前支持 square；shopify/toast/clover 依次扩展同一形态。
 * 幂等：order_no = SQ-<外部ID>，重复同步不产生重复订单。
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

  // 读取已保存的 Square 配置（AES-256-GCM 解密）
  const cfgRes = await scopedTable(ctx, 'integration_configs', 'id, config_encrypted, last_sync_at')
    .eq('provider', 'square').eq('is_enabled', true).maybeSingle();
  if (cfgRes.error) return NextResponse.json({ error: cfgRes.error.message }, { status: 500 });
  const row = cfgRes.data as { id: string; config_encrypted: string | null; last_sync_at: string | null } | null;

  let accessToken = '';
  let locationIds: string[] = [];
  if (row?.config_encrypted) {
    try {
      const cfg = JSON.parse(decrypt(row.config_encrypted)) as { accessToken?: string; locationId?: string; locationIds?: string[] };
      accessToken = cfg.accessToken ?? '';
      locationIds = Array.isArray(cfg.locationIds) ? cfg.locationIds : typeof cfg.locationId === 'string' ? cfg.locationId.split(',') : [];
    } catch {
      return NextResponse.json({ error: 'failed to decrypt square config' }, { status: 500 });
    }
  }

  let orders: SquareOrder[];
  if (accessToken) {
    if (locationIds.length === 0) return NextResponse.json({ error: 'square location ID is required' }, { status: 409 });
    // Square can upload offline POS orders days later. Always overlap the watermark by 72 hours.
    const watermark = row?.last_sync_at ? new Date(row.last_sync_at).getTime() - 72 * 86400000 : Date.now() - 30 * 86400000;
    orders = await fetchSquareOrders(accessToken, new Date(watermark).toISOString(), locationIds);
  } else if (DEMO) {
    // 演示模式：无凭据时使用沙箱样本，验证「同步路由 → orders 表 → 经营数据页」闭环
    orders = sandboxSquareOrders();
  } else {
    return NextResponse.json({ error: 'square not connected' }, { status: 409 });
  }

  const supabase = getSupabaseClient();
  let synced = 0;
  const errors: string[] = [];
  for (const o of orders) {
    const mapped = mapSquareOrder(o);
    const record: Record<string, unknown> = {
      tenant_id: ctx.tenantId,
      business_id: ctx.businessId,
      ...mapped,
      channel: 'dine_in',
      source: 'square',
    };
    const write = await supabase.from('orders').upsert(record, {
      onConflict: 'tenant_id,business_id,source,external_id',
    });
    if (write.error) { errors.push(write.error.message); continue; }
    synced += 1;
  }

  if (row) {
    const { error } = await updateWithScope(ctx, 'integration_configs', row.id, {
      last_sync_at: new Date().toISOString(),
      status: errors.length && !synced ? 'error' : 'connected',
    });
    if (error) console.warn('[integrations/sync] last_sync_at update failed:', error.message);
  }

  return NextResponse.json({ ok: errors.length === 0, provider, synced, total: orders.length, errors });
}

export const POST = protectBusinessMutation(
  { permission: 'integrations:write', action: 'integrations.sync', entity: 'integration_configs' },
  syncIntegration,
);
