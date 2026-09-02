import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext } from '@/lib/tenant';
import { tenantTable, updateWithTenant } from '@/lib/tenant-db';

export async function GET(request: NextRequest) {
  const ctx = getTenantContext(request);
  const category = request.nextUrl.searchParams.get('category');

  const q = tenantTable(ctx.tenantId, 'emails').order('created_at', { ascending: false });
  const chained = category && category !== 'all'
    ? (q as unknown as { eq: (c: string, v: unknown) => typeof q }).eq('category', category)
    : q;
  const emailsRes = await chained;
  if (emailsRes.error) throw new Error(emailsRes.error.message);
  const list = (emailsRes.data ?? []) as { category: string }[];

  const counts: Record<string, number> = { all: list.length };
  if (!category || category === 'all') {
    for (const e of list) counts[e.category] = (counts[e.category] ?? 0) + 1;
  } else {
    const allRowsRes = await tenantTable(ctx.tenantId, 'emails', 'category');
    if (allRowsRes.error) throw new Error(allRowsRes.error.message);
    const allRows = (allRowsRes.data ?? []) as { category: string }[];
    counts.all = allRows.length;
    for (const e of allRows) counts[e.category] = (counts[e.category] ?? 0) + 1;
  }

  const accountsRes = await tenantTable(ctx.tenantId, 'email_accounts', 'id, email, display_name, provider, is_default, status')
    .order('is_default', { ascending: false });

  return NextResponse.json({ emails: list, counts, accounts: accountsRes.data ?? [] });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const ctx = getTenantContext(request);
  const update: Record<string, unknown> = {};
  if (body.status) update.status = body.status;
  if (body.category) update.category = body.category;
  if (body.reply_draft !== undefined) update.reply_draft = body.reply_draft;
  if (body.ai_summary !== undefined) update.ai_summary = body.ai_summary;
  if (body.markAllRead) {
    // tenant 范围内批量把 unread 改成 read
    const q = tenantTable(ctx.tenantId, 'emails', 'id');
    const rowsRes = await (q as unknown as {
      eq: (c: string, v: unknown) => { then: (fn: (v: { data: unknown[] | null; error: { message: string } | null }) => unknown) => Promise<unknown> };
    }).eq('status', 'unread');
    const ids = ((rowsRes.data ?? []) as { id: string }[]).map((r) => r.id);
    for (const id of ids) {
      const { error } = await updateWithTenant(ctx.tenantId, 'emails', id, { status: 'read' });
      if (error) throw new Error(error.message);
    }
    return NextResponse.json({ ok: true });
  }
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const { error } = await updateWithTenant(ctx.tenantId, 'emails', body.id, update);
  if (error) throw new Error(error.message);
  return NextResponse.json({ ok: true });
}
