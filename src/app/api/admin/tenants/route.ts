import { NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { adminHandler } from '@/lib/admin-api';

/**
 * GET /api/admin/tenants — 商户列表（搜索/筛选/状态）。
 * POST /api/admin/tenants — 创建商户 + 初始订阅（幂等：tenant slug 唯一）。
 */
export async function GET(request: Request) {
  return adminHandler(request, { action: 'admin.tenants.list' }, async () => {
    const url = new URL(request.url);
    const search = url.searchParams.get('search')?.trim() ?? '';
    const status = url.searchParams.get('status')?.trim() ?? '';

    const client = getSupabaseClient();
    let query = client
      .from('tenants')
      .select('id, name, slug, created_at')
      .order('created_at', { ascending: false })
      .limit(200);
    if (search) query = query.or(`name.ilike.%${search}%,slug.ilike.%${search}%`);
    const { data: tenants, error } = await query;
    if (error) throw new Error(error.message);

    const { data: subs } = await client
      .from('tenant_subscriptions')
      .select('tenant_id, status, current_period_end, grace_period_end, plan_id');

    const subMap = new Map((subs ?? []).map((s: { tenant_id: string }) => [s.tenant_id, s]));
    let rows = (tenants ?? []).map((t: { id: string; name: string; slug: string; created_at: string }) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      createdAt: t.created_at,
      subscription: (subMap.get(t.id) ?? null) as { status: string; current_period_end: string | null; grace_period_end: string | null; plan_id: string | null } | null,
    }));
    if (status) rows = rows.filter((r) => r.subscription?.status === status);

    return NextResponse.json({ tenants: rows });
  });
}

export async function POST(request: Request) {
  return adminHandler(request, { action: 'admin.tenants.create', roles: ['super_admin', 'admin'] }, async () => {
    const body = await request.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const slug = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : '';
    const planId = typeof body.planId === 'string' ? body.planId : null;
    const trialDays = typeof body.trialDays === 'number' ? Math.min(Math.max(body.trialDays, 0), 90) : 14;
    if (!name || !/^[a-z0-9-]{3,60}$/.test(slug)) {
      return NextResponse.json({ error: 'valid name and slug (a-z0-9-, 3-60) required' }, { status: 400 });
    }

    const client = getSupabaseClient();
    const { data: existing } = await client.from('tenants').select('id').eq('slug', slug).maybeSingle();
    if (existing) {
      return NextResponse.json({ error: 'slug already exists', tenantId: existing.id }, { status: 409 });
    }

    const { data: tenant, error } = await client
      .from('tenants')
      .insert({ name, slug })
      .select('id')
      .single();
    if (error) throw new Error(error.message);

    const now = new Date();
    const periodEnd = new Date(now.getTime() + trialDays * 86400_000);
    await client.from('tenant_subscriptions').insert({
      tenant_id: tenant.id,
      plan_id: planId,
      status: 'trialing',
      started_at: now.toISOString(),
      current_period_end: periodEnd.toISOString(),
      grace_period_end: new Date(periodEnd.getTime() + 7 * 86400_000).toISOString(),
    });
    await client.from('subscription_events').insert({
      event_key: `trial_started:${tenant.id}`,
      tenant_id: tenant.id,
      type: 'trial_started',
      payload: { trialDays },
      processed_at: now.toISOString(),
    });

    return NextResponse.json({ ok: true, tenantId: tenant.id }, { status: 201 });
  });
}
