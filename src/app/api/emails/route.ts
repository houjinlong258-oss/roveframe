import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';

export async function GET(request: NextRequest) {
  const supabase = getSupabaseClient();
  const category = request.nextUrl.searchParams.get('category');

  let q = supabase.from('emails').select('*').order('created_at', { ascending: false });
  if (category && category !== 'all') q = q.eq('category', category);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const list = data ?? [];

  const counts: Record<string, number> = { all: list.length };
  if (!category || category === 'all') {
    for (const e of list) counts[e.category] = (counts[e.category] ?? 0) + 1;
  } else {
    const { data: allRows, error: allErr } = await supabase.from('emails').select('category');
    if (allErr) throw new Error(allErr.message);
    counts.all = allRows?.length ?? 0;
    for (const e of allRows ?? []) counts[e.category] = (counts[e.category] ?? 0) + 1;
  }

  const { data: accounts } = await supabase
    .from('email_accounts')
    .select('id, email, display_name, provider, is_default, status')
    .order('is_default', { ascending: false });

  return NextResponse.json({ emails: list, counts, accounts: accounts ?? [] });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const supabase = getSupabaseClient();
  const update: Record<string, unknown> = {};
  if (body.status) update.status = body.status;
  if (body.category) update.category = body.category;
  if (body.reply_draft !== undefined) update.reply_draft = body.reply_draft;
  if (body.ai_summary !== undefined) update.ai_summary = body.ai_summary;
  if (body.markAllRead) {
    const { error } = await supabase.from('emails').update({ status: 'read' }).eq('status', 'unread');
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  }
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const { error } = await supabase.from('emails').update(update).eq('id', body.id);
  if (error) throw new Error(error.message);
  return NextResponse.json({ ok: true });
}
