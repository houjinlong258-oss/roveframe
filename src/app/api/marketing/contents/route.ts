import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext } from '@/lib/tenant';
import {
  deleteWithTenant,
  insertWithTenant,
  tenantTable,
  updateWithTenant,
} from '@/lib/tenant-db';

export async function GET(request: NextRequest) {
  const ctx = getTenantContext(request);
  const { data, error } = await tenantTable(
    ctx.tenantId,
    'marketing_contents',
    'id, type, title, brief, content, status, send_stats, created_at',
  ).order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return NextResponse.json({ contents: data ?? [] });
}

export async function POST(request: NextRequest) {
  const ctx = getTenantContext(request);
  const body = await request.json();
  const { data, error } = await insertWithTenant(ctx.tenantId, 'marketing_contents', {
    type: body.type ?? 'campaign',
    title: body.title,
    brief: body.brief ?? null,
    content: body.content,
    status: body.status ?? 'draft',
  })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return NextResponse.json({ id: (data as { id: string }).id });
}

export async function PATCH(request: NextRequest) {
  const ctx = getTenantContext(request);
  const body = await request.json();
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.status) update.status = body.status;
  if (body.send_stats) update.send_stats = body.send_stats;
  const { error } = await updateWithTenant(ctx.tenantId, 'marketing_contents', body.id, update);
  if (error) throw new Error(error.message);
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const ctx = getTenantContext(request);
  const id = request.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const { error } = await deleteWithTenant(ctx.tenantId, 'marketing_contents', id);
  if (error) throw new Error(error.message);
  return NextResponse.json({ ok: true });
}
