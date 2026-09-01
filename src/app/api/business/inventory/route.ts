import { NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';

// 库存（ERPNext 同步数据，未接入时回落平台数据）
export async function GET() {
  const supabase = getSupabaseClient();

  const { data: items, error } = await supabase.from('inventory_items').select('*').order('name');
  if (error) throw new Error(error.message);

  const { data: erp } = await supabase
    .from('integration_configs')
    .select('provider, status, last_sync_at, is_enabled')
    .eq('provider', 'erpnext')
    .maybeSingle();

  const list = items ?? [];
  const lowStock = list.filter((i) => Number(i.current_stock) > 0 && Number(i.current_stock) < Number(i.safety_stock)).length;
  const outOfStock = list.filter((i) => Number(i.current_stock) <= 0).length;

  return NextResponse.json({
    items: list,
    stats: { total: list.length, lowStock, outOfStock },
    source: {
      provider: 'erpnext',
      connected: erp?.status === 'connected',
      lastSyncAt: erp?.last_sync_at ?? null,
    },
  });
}
