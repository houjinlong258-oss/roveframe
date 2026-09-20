import { NextResponse } from 'next/server';
import {
  canonicalizeEmail,
  findUnsubscribeByToken,
  recordUnsubscribe,
} from '@/lib/email/unsubscribe';

/**
 * 邮件退订入口（**公开**：收件人没有本站会话，凭令牌证明身份）。
 *
 * - `GET  /api/email/unsubscribe?token=…` 给人看：返回一个自包含的确认页（HTML）。
 * - `POST /api/email/unsubscribe?token=…` 给邮件客户端看：RFC 8058 的一键退订
 *   （`List-Unsubscribe-Post: List-Unsubscribe=One-Click`）会直接 POST 到这里。
 *
 * 两个方法都**立即生效**，不做二次确认 —— 合规要求是"退订必须被遵守"，
 * 而一键退订的前提就是客户端点一下即完成。GET 返回的页面只是告知，不是确认步骤。
 *
 * 令牌无效时返回 404 且不泄漏任何信息（令牌是随机 32 字节，猜测不可行）。
 */

export const dynamic = 'force-dynamic';

function htmlPage(title: string, message: string): string {
  // 自包含、无外部资源、无 JS：邮件客户端内嵌浏览器与老旧设备都能打开
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
 body{margin:0;padding:48px 20px;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:#0d0f12;color:#e8eaed}
 .card{max-width:520px;margin:0 auto;background:#161a1f;border:1px solid #262c34;border-radius:14px;padding:32px}
 h1{font-size:20px;margin:0 0 12px}
 p{margin:0 0 8px;color:#b6bdc7}
 .addr{color:#e8eaed;font-weight:600}
</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

function html(body: string, status: number): NextResponse {
  return new NextResponse(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function tokenFrom(request: Request): string {
  return new URL(request.url).searchParams.get('token')?.trim() ?? '';
}

export async function GET(request: Request) {
  const token = tokenFrom(request);
  if (!token) {
    return html(htmlPage('Invalid link', 'This unsubscribe link is missing its token.'), 400);
  }
  let record;
  try {
    record = await findUnsubscribeByToken(token);
  } catch (error) {
    console.error('[email/unsubscribe] token lookup failed:', error instanceof Error ? error.message : String(error));
    return html(htmlPage('Temporarily unavailable', 'We could not process this link right now. Please try again later.'), 503);
  }
  if (!record) {
    return html(htmlPage('Invalid link', 'This unsubscribe link is not valid or has already been used.'), 404);
  }
  try {
    await recordUnsubscribe({
      tenantId: record.tenant_id,
      businessId: record.business_id,
      address: record.email,
      token,
      reason: 'link',
      source: 'email_link_get',
    });
  } catch (error) {
    console.error('[email/unsubscribe] record failed:', error instanceof Error ? error.message : String(error));
    return html(htmlPage('Temporarily unavailable', 'We could not process this link right now. Please try again later.'), 503);
  }
  return html(
    htmlPage(
      'You are unsubscribed',
      `Marketing emails will no longer be sent to <span class="addr">${record.email}</span>.`,
    ),
    200,
  );
}

export async function POST(request: Request) {
  const token = tokenFrom(request);
  if (!token) return NextResponse.json({ error: 'token required' }, { status: 400 });
  let record;
  try {
    record = await findUnsubscribeByToken(token);
  } catch (error) {
    console.error('[email/unsubscribe] token lookup failed:', error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: 'unsubscribe temporarily unavailable' }, { status: 503 });
  }
  if (!record) return NextResponse.json({ error: 'invalid token' }, { status: 404 });
  try {
    const result = await recordUnsubscribe({
      tenantId: record.tenant_id,
      businessId: record.business_id,
      address: canonicalizeEmail(record.email),
      token,
      reason: 'link',
      source: 'one_click_post',
    });
    return NextResponse.json(
      { ok: true, idempotent: !result.created, email: canonicalizeEmail(record.email) },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    console.error('[email/unsubscribe] record failed:', error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: 'unsubscribe temporarily unavailable' }, { status: 503 });
  }
}
