import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { decrypt } from '@/lib/crypto';
import nodemailer from 'nodemailer';

interface SmtpCredentials {
  smtp_user?: string;
  smtp_pass?: string;
}

// 通过绑定的邮箱账号真实发送回复
export async function POST(request: NextRequest) {
  const body = await request.json();
  const emailId = body.emailId as string;
  const replyBody = (body.reply as string) ?? '';
  const accountId = body.accountId as string | undefined;
  if (!emailId || !replyBody.trim()) {
    return NextResponse.json({ error: 'emailId and reply required' }, { status: 400 });
  }

  const supabase = getSupabaseClient();
  const { data: email, error } = await supabase.from('emails').select('*').eq('id', emailId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!email) return NextResponse.json({ error: 'Email not found' }, { status: 404 });

  // 选发件账号
  let q = supabase.from('email_accounts').select('*').eq('status', 'active');
  q = accountId ? q.eq('id', accountId) : q.eq('is_default', true);
  const { data: account, error: aErr } = await q.maybeSingle();
  if (aErr) throw new Error(aErr.message);
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

  const { error: upErr } = await supabase
    .from('emails')
    .update({ status: 'replied', reply_draft: replyBody })
    .eq('id', emailId);
  if (upErr) throw new Error(upErr.message);

  return NextResponse.json({ ok: true });
}
