import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { encrypt } from '@/lib/crypto';

// 外部系统集成（ERPNext / Square / Shopify / Stripe / PayPal）
export async function GET() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('integration_configs')
    .select('id, provider, is_enabled, sync_scope, last_sync_at, status, created_at');
  if (error) throw new Error(error.message);

  // 附加各集成同步出的数据量
  const { count: invCount } = await supabase.from('inventory_items').select('id', { count: 'exact', head: true });
  const { count: sqCount } = await supabase.from('orders').select('id', { count: 'exact', head: true }).eq('source', 'square');
  const { count: shCount } = await supabase.from('orders').select('id', { count: 'exact', head: true }).eq('source', 'shopify');

  const counts: Record<string, number> = { erpnext: invCount ?? 0, square: sqCount ?? 0, shopify: shCount ?? 0 };
  const integrations = (data ?? []).map((i) => ({ ...i, recordCount: counts[i.provider] ?? 0 }));
  return NextResponse.json({ integrations });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const provider: string = body.provider;
  if (!provider) return NextResponse.json({ error: 'provider required' }, { status: 400 });

  const supabase = getSupabaseClient();
  const record = {
    provider,
    config_encrypted: encrypt(JSON.stringify(body.config ?? {})),
    sync_scope: body.syncScope ?? [],
    is_enabled: true,
    status: 'connected',
    last_sync_at: new Date().toISOString(),
  };

  const { data: existing } = await supabase.from('integration_configs').select('id').eq('provider', provider).maybeSingle();
  if (existing) {
    const { error } = await supabase.from('integration_configs').update(record).eq('id', existing.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase.from('integration_configs').insert(record);
    if (error) throw new Error(error.message);
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const provider = request.nextUrl.searchParams.get('provider');
  if (!provider) return NextResponse.json({ error: 'provider required' }, { status: 400 });
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from('integration_configs')
    .update({ is_enabled: false, status: 'disconnected' })
    .eq('provider', provider);
  if (error) throw new Error(error.message);
  return NextResponse.json({ ok: true });
}
