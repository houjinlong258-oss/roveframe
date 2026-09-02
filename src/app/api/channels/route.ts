import { NextRequest, NextResponse } from 'next/server';
import { encrypt } from '@/lib/crypto';
import { CHANNEL_KEYS, type ChannelKey } from '@/lib/channels-presets';
import { getTenantContext } from '@/lib/tenant';
import {
  insertWithTenant,
  tenantTable,
  updateWithTenant,
} from '@/lib/tenant-db';

// 社交通讯渠道：列表 / 连接 / 断开（复用 integration_configs 表，provider 为渠道 key）
export async function GET(request: NextRequest) {
  const ctx = getTenantContext(request);
  const { data, error } = await tenantTable(
    ctx.tenantId,
    'integration_configs',
    'provider, is_enabled, status, last_sync_at',
  )
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
  const ctx = getTenantContext(request);
  const body = await request.json();
  const provider: ChannelKey = body.provider;
  if (!provider || !CHANNEL_KEYS.includes(provider)) {
    return NextResponse.json({ error: 'invalid channel provider' }, { status: 400 });
  }

  const record = {
    provider,
    config_encrypted: encrypt(JSON.stringify(body.config ?? {})),
    sync_scope: [],
    is_enabled: true,
    status: 'connected',
    last_sync_at: new Date().toISOString(),
  };

  const existingRes = await tenantTable(ctx.tenantId, 'integration_configs', 'id')
    .eq('provider', provider)
    .maybeSingle();
  if (existingRes.error) throw new Error(existingRes.error.message);
  const existing = existingRes.data as { id: string } | null;

  if (existing) {
    const { error } = await updateWithTenant(ctx.tenantId, 'integration_configs', existing.id, record);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await insertWithTenant(ctx.tenantId, 'integration_configs', record);
    if (error) throw new Error(error.message);
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const ctx = getTenantContext(request);
  const provider = request.nextUrl.searchParams.get('provider');
  if (!provider) return NextResponse.json({ error: 'provider required' }, { status: 400 });
  // 软断开：先查 id 再 update（保持 tenant 内限定）
  const res = await tenantTable(ctx.tenantId, 'integration_configs', 'id').eq('provider', provider).maybeSingle();
  if (res.error) throw new Error(res.error.message);
  const row = res.data as { id: string } | null;
  if (!row) return NextResponse.json({ ok: true });
  const { error } = await updateWithTenant(ctx.tenantId, 'integration_configs', row.id, {
    is_enabled: false,
    status: 'disconnected',
  });
  if (error) throw new Error(error.message);
  return NextResponse.json({ ok: true });
}
