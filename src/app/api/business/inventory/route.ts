import { NextResponse } from 'next/server';
import { getTenantContext } from '@/lib/tenant';
import { scopedTable } from '@/lib/tenant-db';

// 库存（ERPNext 同步数据，未接入时回落平台数据）
export async function GET(request: Request) {
  const ctx = await getTenantContext(request);

  const itemsRes = await scopedTable(ctx, 'inventory_items').order('name');
  if (itemsRes.error) throw new Error(itemsRes.error.message);

  // integration_configs 属业务表（tenant+business 范围），必须走 scopedTable，
  // 禁止 plainTable 无过滤直查（否则多租户下会读到其它租户/门店的集成状态）。
  const erp = await scopedTable(
    ctx,
    'integration_configs',
    'provider, status, last_sync_at, is_enabled',
  )
    .eq('provider', 'erpnext')
    .maybeSingle();
  const erpRow = erp.data as { status?: string; last_sync_at?: string } | null;

  const list = (itemsRes.data ?? []) as {
    current_stock: number | string;
    safety_stock: number | string;
    [k: string]: unknown;
  }[];
  const lowStock = list.filter(
    (i) => Number(i.current_stock) > 0 && Number(i.current_stock) < Number(i.safety_stock),
  ).length;
  const outOfStock = list.filter((i) => Number(i.current_stock) <= 0).length;

  return NextResponse.json({
    items: list,
    stats: { total: list.length, lowStock, outOfStock },
    source: {
      provider: 'erpnext',
      connected: erpRow?.status === 'connected',
      lastSyncAt: erpRow?.last_sync_at ?? null,
    },
  });
}
