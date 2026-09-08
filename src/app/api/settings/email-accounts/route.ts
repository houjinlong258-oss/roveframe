import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { encrypt } from '@/lib/crypto';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { protectBusinessMutation } from '@/lib/mutation-guard';

// 邮箱账号接入（Gmail/Outlook OAuth 占位 + 自定义 SMTP/IMAP 真实收发）
export async function GET(request: NextRequest) {
  const context = requireBusinessContext(await getTenantContext(request));
  requirePermission(context, 'settings:read');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('email_accounts')
    .select('id, provider, email, display_name, auth_type, smtp_host, smtp_port, imap_host, imap_port, is_default, status, created_at')
    .eq('tenant_id', context.tenantId)
    .eq('business_id', context.businessId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return NextResponse.json({ accounts: data ?? [] });
}

async function saveEmailAccount(request: NextRequest) {
  const context = requireBusinessContext(await getTenantContext(request));
  requirePermission(context, 'settings:write');
  const body = await request.json();
  const supabase = getSupabaseClient();

  if (body.isDefault) {
    const reset = await supabase.from('email_accounts')
      .update({ is_default: false })
      .eq('is_default', true)
      .eq('tenant_id', context.tenantId)
      .eq('business_id', context.businessId);
    if (reset.error) throw new Error(reset.error.message);
  }

  const credentials = JSON.stringify({
    smtp_user: body.smtpUser ?? body.email,
    smtp_pass: body.smtpPass ?? '',
    imap_user: body.imapUser ?? body.smtpUser ?? body.email,
    imap_pass: body.imapPass ?? body.smtpPass ?? '',
    access_token: body.accessToken ?? '',
  });
  const { data, error } = await supabase
    .from('email_accounts')
    .insert({
      tenant_id: context.tenantId,
      business_id: context.businessId,
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

async function deleteEmailAccount(request: NextRequest) {
  const context = requireBusinessContext(await getTenantContext(request));
  requirePermission(context, 'settings:write');
  const id = request.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const supabase = getSupabaseClient();
  const { error } = await supabase.from('email_accounts')
    .delete()
    .eq('id', id)
    .eq('tenant_id', context.tenantId)
    .eq('business_id', context.businessId);
  if (error) throw new Error(error.message);
  return NextResponse.json({ ok: true });
}

export const POST = protectBusinessMutation(
  { permission: 'settings:write', action: 'email_accounts.save', entity: 'email_accounts' },
  saveEmailAccount,
);
export const DELETE = protectBusinessMutation(
  { permission: 'settings:write', action: 'email_accounts.delete', entity: 'email_accounts' },
  deleteEmailAccount,
);
