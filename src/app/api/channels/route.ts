import { NextRequest, NextResponse } from 'next/server';
import { encrypt } from '@/lib/crypto';
import { CHANNEL_KEYS, type ChannelKey } from '@/lib/channels-presets';
import { getTenantContext, requireBusinessContext } from '@/lib/tenant';
import {
  insertWithScope,
  scopedTable,
  updateWithScope,
} from '@/lib/tenant-db';
import { protectBusinessMutation } from '@/lib/mutation-guard';

// 社交通讯渠道：列表 / 连接 / 断开（复用 integration_configs 表，provider 为渠道 key）
export async function GET(request: NextRequest) {
  const ctx = requireBusinessContext(await getTenantContext(request));
  const { data, error } = await scopedTable(
    ctx,
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

async function connectChannel(request: NextRequest) {
  const ctx = requireBusinessContext(await getTenantContext(request));
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

  const existingRes = await scopedTable(ctx, 'integration_configs', 'id')
    .eq('provider', provider)
    .maybeSingle();
  if (existingRes.error) throw new Error(existingRes.error.message);
  const existing = existingRes.data as { id: string } | null;

  if (existing) {
    const { error } = await updateWithScope(ctx, 'integration_configs', existing.id, record);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await insertWithScope(ctx, 'integration_configs', record);
    if (error) throw new Error(error.message);
  }
  return NextResponse.json({ ok: true });
}

async function disconnectChannel(request: NextRequest) {
  const ctx = requireBusinessContext(await getTenantContext(request));
  const provider = request.nextUrl.searchParams.get('provider');
  if (!provider) return NextResponse.json({ error: 'provider required' }, { status: 400 });
  // 软断开：先查 id 再 update（保持 tenant 内限定）
  const res = await scopedTable(ctx, 'integration_configs', 'id').eq('provider', provider).maybeSingle();
  if (res.error) throw new Error(res.error.message);
  const row = res.data as { id: string } | null;
  if (!row) return NextResponse.json({ ok: true });
  const { error } = await updateWithScope(ctx, 'integration_configs', row.id, {
    is_enabled: false,
    status: 'disconnected',
  });
  if (error) throw new Error(error.message);
  return NextResponse.json({ ok: true });
}

export const POST = protectBusinessMutation(
  { permission: 'integrations:write', action: 'channels.connect', entity: 'integration_configs' },
  connectChannel,
);
export const DELETE = protectBusinessMutation(
  { permission: 'integrations:write', action: 'channels.disconnect', entity: 'integration_configs' },
  disconnectChannel,
);
