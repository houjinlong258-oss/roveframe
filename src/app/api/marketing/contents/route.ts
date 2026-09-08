import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requireBusinessContext } from '@/lib/tenant';
import {
  deleteWithScope,
  insertWithScope,
  scopedTable,
  updateWithScope,
} from '@/lib/tenant-db';
import { protectBusinessMutation } from '@/lib/mutation-guard';

export async function GET(request: NextRequest) {
  const ctx = requireBusinessContext(await getTenantContext(request));
  const { data, error } = await scopedTable(
    ctx,
    'marketing_contents',
    'id, type, title, brief, content, status, send_stats, created_at',
  ).order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return NextResponse.json({ contents: data ?? [] });
}

async function createContent(request: NextRequest) {
  const ctx = requireBusinessContext(await getTenantContext(request));
  const body = await request.json();
  const { data, error } = await insertWithScope(ctx, 'marketing_contents', {
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

async function updateContent(request: NextRequest) {
  const ctx = requireBusinessContext(await getTenantContext(request));
  const body = await request.json();
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.status) update.status = body.status;
  if (body.send_stats) update.send_stats = body.send_stats;
  const { error } = await updateWithScope(ctx, 'marketing_contents', body.id, update);
  if (error) throw new Error(error.message);
  return NextResponse.json({ ok: true });
}

async function deleteContent(request: NextRequest) {
  const ctx = requireBusinessContext(await getTenantContext(request));
  const id = request.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const { error } = await deleteWithScope(ctx, 'marketing_contents', id);
  if (error) throw new Error(error.message);
  return NextResponse.json({ ok: true });
}

export const POST = protectBusinessMutation(
  { permission: 'marketing:write', action: 'marketing_content.create', entity: 'marketing_contents' },
  createContent,
);
export const PATCH = protectBusinessMutation(
  { permission: 'marketing:write', action: 'marketing_content.update', entity: 'marketing_contents' },
  updateContent,
);
export const DELETE = protectBusinessMutation(
  { permission: 'marketing:write', action: 'marketing_content.delete', entity: 'marketing_contents' },
  deleteContent,
);
