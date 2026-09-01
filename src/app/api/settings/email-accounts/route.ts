import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { encrypt } from '@/lib/crypto';

// 邮箱账号接入（Gmail/Outlook OAuth 占位 + 自定义 SMTP/IMAP 真实收发）
export async function GET() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('email_accounts')
    .select('id, provider, email, display_name, auth_type, smtp_host, smtp_port, imap_host, imap_port, is_default, status, created_at')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return NextResponse.json({ accounts: data ?? [] });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const supabase = getSupabaseClient();

  if (body.isDefault) {
    await supabase.from('email_accounts').update({ is_default: false }).eq('is_default', true);
  }

  const credentials = JSON.stringify({ smtp_user: body.smtpUser ?? body.email, smtp_pass: body.smtpPass ?? '' });
  const { data, error } = await supabase
    .from('email_accounts')
    .insert({
      provider: body.provider ?? 'smtp',
      email: body.email,
      display_name: body.displayName ?? null,
      auth_type: body.authType ?? 'password',
      credentials_encrypted: encrypt(credentials),
      smtp_host: body.smtpHost ?? null,
      smtp_port: body.smtpPort ?? null,
      imap_host: body.imapHost ?? null,
      imap_port: body.imapPort ?? null,
      is_default: body.isDefault ?? false,
    })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return NextResponse.json({ id: data.id });
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const supabase = getSupabaseClient();
  const { error } = await supabase.from('email_accounts').delete().eq('id', id);
  if (error) throw new Error(error.message);
  return NextResponse.json({ ok: true });
}
