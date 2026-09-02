import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { encrypt } from '@/lib/crypto';
import { CHANNEL_KEYS, type ChannelKey } from '@/lib/channels-presets';

// 社交通讯渠道：列表 / 连接 / 断开（复用 integration_configs 表，provider 为渠道 key）
export async function GET() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('integration_configs')
    .select('provider, is_enabled, status, last_sync_at')
    .in('provider', CHANNEL_KEYS);
  if (error) throw new Error(error.message);

  const connected = new Set(
    ((data ?? []) as { provider: ChannelKey; is_enabled: boolean; status: string }[])
      .filter((c) => c.is_enabled && c.status === 'connected')
      .map((c) => c.provider),
  );
  return NextResponse.json({ channels: connected ? Array.from(connected) : [] });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const provider: ChannelKey = body.provider;
  if (!provider || !CHANNEL_KEYS.includes(provider)) {
    return NextResponse.json({ error: 'invalid channel provider' }, { status: 400 });
  }

  const supabase = getSupabaseClient();
  const record = {
    provider,
    config_encrypted: encrypt(JSON.stringify(body.config ?? {})),
    sync_scope: [],
    is_enabled: true,
    status: 'connected',
    last_sync_at: new Date().toISOString(),
  };

  const { data: existing } = await supabase
    .from('integration_configs')
    .select('id')
    .eq('provider', provider)
    .maybeSingle();
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