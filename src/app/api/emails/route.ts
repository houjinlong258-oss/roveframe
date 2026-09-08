import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { scopedTable, updateWithScope } from '@/lib/tenant-db';
import { protectBusinessMutation } from '@/lib/mutation-guard';
import { errorResponse } from '@/lib/api-helpers';

export async function GET(request: NextRequest) {
  try {
    const ctx = requireBusinessContext(await getTenantContext(request));
    // P0-4：读接口 RBAC —— staff 无 emails:read（邮件正文含客户 PII）。
    requirePermission(ctx, 'emails:read');
    const category = request.nextUrl.searchParams.get('category');

    const q = scopedTable(ctx, 'emails').order('created_at', { ascending: false });
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
      const allRowsRes = await scopedTable(ctx, 'emails', 'category');
      if (allRowsRes.error) throw new Error(allRowsRes.error.message);
      const allRows = (allRowsRes.data ?? []) as { category: string }[];
      counts.all = allRows.length;
      for (const e of allRows) counts[e.category] = (counts[e.category] ?? 0) + 1;
    }

    const accountsRes = await scopedTable(ctx, 'email_accounts', 'id, email, display_name, provider, is_default, status')
      .order('is_default', { ascending: false });

    return NextResponse.json({ emails: list, counts, accounts: accountsRes.data ?? [] });
  } catch (error) {
    return errorResponse(error);
  }
}

async function updateEmail(request: NextRequest) {
  const body = await request.json();
  const ctx = requireBusinessContext(await getTenantContext(request));
  const update: Record<string, unknown> = {};
  if (body.status) update.status = body.status;
  if (body.category) update.category = body.category;
  if (body.reply_draft !== undefined) update.reply_draft = body.reply_draft;
  if (body.ai_summary !== undefined) update.ai_summary = body.ai_summary;
  if (body.markAllRead) {
    // tenant 范围内批量把 unread 改成 read
    const q = scopedTable(ctx, 'emails', 'id');
    const rowsRes = await (q as unknown as {
      eq: (c: string, v: unknown) => { then: (fn: (v: { data: unknown[] | null; error: { message: string } | null }) => unknown) => Promise<unknown> };
    }).eq('status', 'unread');
    const ids = ((rowsRes.data ?? []) as { id: string }[]).map((r) => r.id);
    for (const id of ids) {
      const { error } = await updateWithScope(ctx, 'emails', id, { status: 'read' });
      if (error) throw new Error(error.message);
    }
    return NextResponse.json({ ok: true });
  }
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const { error } = await updateWithScope(ctx, 'emails', body.id, update);
  if (error) throw new Error(error.message);
  return NextResponse.json({ ok: true });
}

export const PATCH = protectBusinessMutation(
  { permission: 'emails:write', action: 'emails.update', entity: 'emails' },
  updateEmail,
);
