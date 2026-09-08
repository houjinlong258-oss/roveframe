import { NextRequest, NextResponse } from 'next/server';
import { encrypt } from '@/lib/crypto';
import { getTenantContext, requireBusinessContext } from '@/lib/tenant';
import {
  insertWithScope,
  scopedTable,
  updateWithScope,
} from '@/lib/tenant-db';
import { protectBusinessMutation } from '@/lib/mutation-guard';

// 外部系统集成（ERPNext / Square / Shopify / Stripe / PayPal）
export async function GET(request: NextRequest) {
  const ctx = requireBusinessContext(await getTenantContext(request));
  const { data, error } = await scopedTable(
    ctx,
    'integration_configs',
    'id, provider, is_enabled, sync_scope, last_sync_at, status, created_at',
  );
  if (error) throw new Error(error.message);

  // 附加各集成同步出的数据量（tenant 内, 用普通 select 计数）
  const invList = await scopedTable(ctx, 'inventory_items', 'id');
  const sqList = await scopedTable(ctx, 'orders', 'id').eq('source', 'square');
  const shList = await scopedTable(ctx, 'orders', 'id').eq('source', 'shopify');

  const counts: Record<string, number> = {
    erpnext: (invList.data ?? []).length,
    square: (sqList.data ?? []).length,
    shopify: (shList.data ?? []).length,
  };
  const integrations = ((data ?? []) as { provider: string; [k: string]: unknown }[]).map((i) => ({
    ...i,
    recordCount: counts[i.provider] ?? 0,
  }));
  return NextResponse.json({ integrations });
}

async function connectIntegration(request: NextRequest) {
  const ctx = requireBusinessContext(await getTenantContext(request));
  const body = await request.json();
  const provider: string = body.provider;
  if (!provider) return NextResponse.json({ error: 'provider required' }, { status: 400 });

  const record = {
    provider,
    config_encrypted: encrypt(JSON.stringify(body.config ?? {})),
    sync_scope: body.syncScope ?? [],
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

async function disconnectIntegration(request: NextRequest) {
  const ctx = requireBusinessContext(await getTenantContext(request));
  const provider = request.nextUrl.searchParams.get('provider');
  if (!provider) return NextResponse.json({ error: 'provider required' }, { status: 400 });
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
  { permission: 'integrations:write', action: 'integrations.connect', entity: 'integration_configs' },
  connectIntegration,
);
export const DELETE = protectBusinessMutation(
  { permission: 'integrations:write', action: 'integrations.disconnect', entity: 'integration_configs' },
  disconnectIntegration,
);
