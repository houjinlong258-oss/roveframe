import { NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { adminHandler } from '@/lib/admin-api';
import { writePlatformAudit } from '@/lib/platform-admin';
import { mask } from '@/lib/crypto';

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/admin/tenants/[id] — 商户详情：订阅、业务数、AI 用量、Provider 掩码状态。
 * PATCH — 暂停/恢复/延长到期/调整套餐（全部幂等 + 审计）。
 */
export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  return adminHandler(request, { action: 'admin.tenants.read', targetTenantId: id }, async () => {
    const client = getSupabaseClient();
    const [tenant, sub, businesses, usage, providers] = await Promise.all([
      client.from('tenants').select('id, name, slug, created_at').eq('id', id).maybeSingle(),
      client.from('tenant_subscriptions').select('*').eq('tenant_id', id).maybeSingle(),
      client.from('businesses').select('id, name, industry', { count: 'exact' }).eq('tenant_id', id),
      client.from('ai_usage_ledger').select('provider, model, status, input_tokens, output_tokens, created_at').eq('tenant_id', id).order('created_at', { ascending: false }).limit(100),
      client.from('model_configs').select('provider, is_enabled, last_test_ok, last_tested_at, api_key_encrypted').eq('tenant_id', id),
    ]);
    if (!tenant.data) return NextResponse.json({ error: 'tenant not found' }, { status: 404 });

    // Provider 状态只暴露掩码与连接状态；绝不返回 api_key_encrypted 或明文
    const providerStates = ((providers.data ?? []) as Array<Record<string, unknown>>).map((p) => ({
      provider: p.provider,
      isEnabled: p.is_enabled,
      lastTestOk: p.last_test_ok,
      lastTestedAt: p.last_tested_at,
      keyConfigured: Boolean(p.api_key_encrypted),
      maskedKey: p.api_key_encrypted ? mask('configured-key') : '',
    }));

    return NextResponse.json({
      tenant: tenant.data,
      subscription: sub.data ?? null,
      businesses: businesses.data ?? [],
      recentUsage: usage.data ?? [],
      providers: providerStates,
    });
  });
}

export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  return adminHandler(request, { action: 'admin.tenants.update', roles: ['super_admin', 'admin'], targetTenantId: id }, async (ctx, requestId) => {
    const body = await request.json();
    const action = typeof body.action === 'string' ? body.action : '';
    const client = getSupabaseClient();

    const { data: sub, error } = await client
      .from('tenant_subscriptions')
      .select('*')
      .eq('tenant_id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!sub) return NextResponse.json({ error: 'subscription not found' }, { status: 404 });

    const now = new Date().toISOString();
    const updates: Record<string, unknown> = { updated_at: now };
    let eventType: string | null = null;

    switch (action) {
      case 'suspend':
        if (sub.status === 'suspended') return NextResponse.json({ ok: true, idempotent: true });
        updates.status = 'suspended';
        eventType = 'suspended';
        break;
      case 'resume': {
        if (sub.status !== 'suspended') return NextResponse.json({ ok: true, idempotent: true });
        const stillValid = sub.current_period_end && new Date(sub.current_period_end).getTime() > Date.now();
        updates.status = stillValid ? 'active' : 'grace';
        eventType = 'resumed';
        break;
      }
      case 'extend': {
        const days = typeof body.days === 'number' ? Math.min(Math.max(body.days, 1), 365) : 30;
        const base = sub.current_period_end && new Date(sub.current_period_end).getTime() > Date.now()
          ? new Date(sub.current_period_end).getTime()
          : Date.now();
        updates.current_period_end = new Date(base + days * 86400_000).toISOString();
        updates.grace_period_end = new Date(base + days * 86400_000 + 7 * 86400_000).toISOString();
        if (sub.status === 'grace' || sub.status === 'past_due') updates.status = 'active';
        eventType = 'extended';
        break;
      }
      case 'set_plan': {
        if (typeof body.planId !== 'string') return NextResponse.json({ error: 'planId required' }, { status: 400 });
        if (sub.plan_id === body.planId) return NextResponse.json({ ok: true, idempotent: true });
        updates.plan_id = body.planId;
        eventType = 'plan_changed';
        break;
      }
      case 'record_offline_renewal': {
        const days = typeof body.days === 'number' ? Math.min(Math.max(body.days, 1), 366) : 30;
        const base = sub.current_period_end && new Date(sub.current_period_end).getTime() > Date.now()
          ? new Date(sub.current_period_end).getTime()
          : Date.now();
        updates.current_period_end = new Date(base + days * 86400_000).toISOString();
        updates.grace_period_end = new Date(base + days * 86400_000 + 7 * 86400_000).toISOString();
        updates.status = 'active';
        updates.renewal_source = 'offline';
        updates.last_payment_status = 'paid_offline';
        updates.amount = typeof body.amount === 'number' ? body.amount : sub.amount;
        updates.currency = typeof body.currency === 'string' ? body.currency : sub.currency;
        eventType = 'renewed';
        break;
      }
      default:
        return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
    }

    const { error: upErr } = await client
      .from('tenant_subscriptions')
      .update(updates)
      .eq('tenant_id', id);
    if (upErr) throw new Error(upErr.message);

    if (eventType) {
      // 幂等：同一管理员同一动作同一时间窗只记一次事件
      await client.from('subscription_events').upsert({
        event_key: `${eventType}:${id}:${requestId}`,
        tenant_id: id,
        type: eventType,
        payload: { action, days: body.days, planId: body.planId },
        processed_at: now,
      }, { onConflict: 'event_key', ignoreDuplicates: true });
    }

    await writePlatformAudit({
      adminId: ctx.adminId,
      action: `admin.subscription.${eventType ?? action}`,
      targetTenantId: id,
      requestId,
      summary: { action, days: body.days, planId: body.planId },
    });

    return NextResponse.json({ ok: true });
  });
}
