import { NextResponse } from 'next/server';
import { getTenantContext } from '@/lib/tenant';
import { scopedTable, plainTable } from '@/lib/tenant-db';

// 库存（ERPNext 同步数据，未接入时回落平台数据）
// （P0-S2 完整版：inventory_items 按 tenant 过滤；integration_configs 是平台配置，plainTable 不过滤）
export async function GET(request: Request) {
  const ctx = await getTenantContext(request);

  const itemsRes = await scopedTable(ctx, 'inventory_items').order('name');
  if (itemsRes.error) throw new Error(itemsRes.error.message);

  // integration_configs 是平台级配置（不是业务数据），用 plainTable
  const erpRes = await plainTable('integration_configs')
    .select('provider, status, last_sync_at, is_enabled') as unknown as {
      eq: (c: string, v: unknown) => {
        maybeSingle: () => Promise<{ data: unknown; error: { message: string } | null }>;
      };
    };
  const erp = await erpRes.eq('provider', 'erpnext').maybeSingle();
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
