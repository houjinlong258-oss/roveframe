import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';

export async function GET() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('marketing_contents')
    .select('id, type, title, brief, content, status, send_stats, created_at')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return NextResponse.json({ contents: data ?? [] });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('marketing_contents')
    .insert({
      type: body.type ?? 'campaign',
      title: body.title,
      brief: body.brief ?? null,
      content: body.content,
      status: body.status ?? 'draft',
    })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return NextResponse.json({ id: data.id });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const supabase = getSupabaseClient();
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.status) update.status = body.status;
  if (body.send_stats) update.send_stats = body.send_stats;
  const { error } = await supabase.from('marketing_contents').update(update).eq('id', body.id);
  if (error) throw new Error(error.message);
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const supabase = getSupabaseClient();
  const { error } = await supabase.from('marketing_contents').delete().eq('id', id);
  if (error) throw new Error(error.message);
  return NextResponse.json({ ok: true });
}
