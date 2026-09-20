import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { encrypt } from '@/lib/crypto';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { protectBusinessMutation } from '@/lib/mutation-guard';
import { presetForHost, verifySmtpConnection } from '@/lib/email/eligibility';

// 邮箱账号接入（Gmail/Outlook OAuth 占位 + 自定义 SMTP/IMAP 真实收发）
export async function GET(request: NextRequest) {
  const context = requireBusinessContext(await getTenantContext(request));
  requirePermission(context, 'settings:read');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('email_accounts')
    // Phase 16：同时返回上次连接验证结果 —— UI 显示的"已连接"必须有证据，
    // 不能因为"有一行记录"就宣称可用。
    .select('id, provider, email, display_name, auth_type, smtp_host, smtp_port, imap_host, imap_port, is_default, status, created_at, last_test_ok, last_tested_at, last_test_error')
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

  // Phase 16 任务 4：保存前**真的连一次** SMTP。
  //
  // 原实现保存即返回成功，UI 随即显示"已连接" —— 而从未连接过。
  // 商家据此发整批营销邮件，然后每一封都失败。宁可保存这一步失败。
  const smtpUser = String(body.smtpUser ?? body.email ?? '');
  const smtpPass = String(body.smtpPass ?? '');
  const requestedHost = typeof body.smtpHost === 'string' ? body.smtpHost.trim() : '';
  // 服务商预设会纠正端口：Outlook/Office 365 不接受 465（见 smtp-presets 注释）
  const preset = presetForHost(requestedHost);
  const requestedPort = Number(body.smtpPort) || preset?.port || null;

  if (!requestedHost) {
    return NextResponse.json({ error: 'smtpHost is required', code: 'missing_smtp_host' }, { status: 400 });
  }

  const verification = await verifySmtpConnection({
    host: requestedHost,
    port: requestedPort,
    user: smtpUser,
    pass: smtpPass,
  });
  if (!verification.ok) {
    console.warn(
      `[settings/email-accounts] SMTP verification failed host=${requestedHost} port=${verification.port} ` +
      `secure=${verification.secure}: ${verification.error}`,
    );
    // 不落库：一个连不上的账号写进去只会让后续每一次发送都失败。
    return NextResponse.json(
      {
        error: `SMTP connection failed: ${verification.error ?? 'unknown error'}`,
        code: 'smtp_verification_failed',
        port: verification.port,
        secure: verification.secure,
        hint: preset?.hint ?? null,
      },
      { status: 400 },
    );
  }

  if (body.isDefault) {
    const reset = await supabase.from('email_accounts')
      .update({ is_default: false })
      .eq('is_default', true)
      .eq('tenant_id', context.tenantId)
      .eq('business_id', context.businessId);
    if (reset.error) throw new Error(reset.error.message);
  }

  const credentials = JSON.stringify({
    smtp_user: smtpUser,
    smtp_pass: smtpPass,
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
      smtp_host: requestedHost,
      smtp_port: verification.port,
      imap_host: body.imapHost ?? null,
      imap_port: body.imapPort ?? null,
      is_default: body.isDefault ?? false,
      last_test_ok: true,
      last_tested_at: new Date().toISOString(),
      last_test_error: null,
    })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return NextResponse.json({
    id: data.id,
    verified: true,
    port: verification.port,
    secure: verification.secure,
  });
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
