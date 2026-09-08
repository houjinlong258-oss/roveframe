import { NextRequest, NextResponse } from 'next/server';
import { decrypt } from '@/lib/crypto';
import nodemailer from 'nodemailer';
import { getTenantContext, requireBusinessContext } from '@/lib/tenant';
import { scopedTable, updateWithScope } from '@/lib/tenant-db';
import { protectBusinessMutation } from '@/lib/mutation-guard';
import { checkFixedWindow, rateLimitResponse } from '@/lib/rate-limit';

interface SmtpCredentials {
  smtp_user?: string;
  smtp_pass?: string;
}

// 通过绑定的邮箱账号真实发送回复
async function sendEmail(request: NextRequest) {
  const ctx = requireBusinessContext(await getTenantContext(request));

  // P0-1：SMTP 外发限流 —— 每商户 30 次/分钟。
  const limit = checkFixedWindow(
    `emails:send:${ctx.tenantId}:${ctx.businessId}`,
    { limit: 30, windowMs: 60_000 },
  );
  if (!limit.ok) return rateLimitResponse(limit);

  const body = await request.json();
  const emailId = body.emailId as string;
  const replyBody = (body.reply as string) ?? '';
  const accountId = body.accountId as string | undefined;
  if (!emailId || !replyBody.trim()) {
    return NextResponse.json({ error: 'emailId and reply required' }, { status: 400 });
  }

  const emailRes = await scopedTable(ctx, 'emails').eq('id', emailId).maybeSingle();
  if (emailRes.error) throw new Error(emailRes.error.message);
  const email = emailRes.data as { from_addr: string; subject: string } | null;
  if (!email) return NextResponse.json({ error: 'Email not found' }, { status: 404 });

  // 选发件账号
  const q = scopedTable(ctx, 'email_accounts', '*').eq('status', 'active');
  const accountQ = accountId
    ? (q as unknown as { eq: (c: string, v: unknown) => typeof q }).eq('id', accountId)
    : (q as unknown as { eq: (c: string, v: unknown) => typeof q }).eq('is_default', true);
  const accountRes = await (accountQ as unknown as {
    maybeSingle: () => Promise<{ data: unknown; error: { message: string } | null }>;
  }).maybeSingle();
  if (accountRes.error) throw new Error(accountRes.error.message);
  const account = accountRes.data as {
    smtp_host?: string;
    smtp_port?: number;
    credentials_encrypted?: string;
    email: string;
    display_name?: string | null;
  } | null;
  if (!account) {
    return NextResponse.json({ error: 'no_account', message: 'No active email account. Configure one in Settings.' }, { status: 400 });
  }

  if (!account.smtp_host || !account.credentials_encrypted) {
    return NextResponse.json({ error: 'account_incomplete', message: 'Email account SMTP not fully configured.' }, { status: 400 });
  }

  let creds: SmtpCredentials = {};
  try {
    creds = JSON.parse(decrypt(account.credentials_encrypted)) as SmtpCredentials;
  } catch {
    return NextResponse.json({ error: 'credentials_invalid' }, { status: 500 });
  }

  try {
    const transporter = nodemailer.createTransport({
      host: account.smtp_host,
      port: account.smtp_port ?? 465,
      secure: (account.smtp_port ?? 465) === 465,
      auth: { user: creds.smtp_user ?? account.email, pass: creds.smtp_pass ?? '' },
    });
    await transporter.sendMail({
      from: account.display_name ? `"${account.display_name}" <${account.email}>` : account.email,
      to: email.from_addr,
      subject: `Re: ${email.subject}`,
      text: replyBody,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'SMTP send failed';
    return NextResponse.json({ error: 'send_failed', message: msg }, { status: 502 });
  }

  const { error: upErr } = await updateWithScope(ctx, 'emails', emailId, {
    status: 'replied',
    reply_draft: replyBody,
  });
  if (upErr) throw new Error(upErr.message);

  return NextResponse.json({ ok: true });
}

export const POST = protectBusinessMutation(
  { permission: 'emails:send', action: 'emails.send', entity: 'emails' },
  sendEmail,
);
