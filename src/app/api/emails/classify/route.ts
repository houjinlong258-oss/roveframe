import { NextRequest, NextResponse } from 'next/server';
import { streamChat, invokeChat } from '@/lib/ai/router';
import { getBusinessContext } from '@/lib/business-context';
import { sseResponse } from '@/lib/api-helpers';
import { getTenantContext } from '@/lib/tenant';
import { tenantTable, updateWithTenant } from '@/lib/tenant-db';
import { HeaderUtils } from 'coze-coding-dev-sdk';

// AI 处理邮件：summarize=生成摘要 / reply=生成回复草稿（流式）
export async function POST(request: NextRequest) {
  const ctx = getTenantContext(request);
  const body = await request.json();
  const emailId = body.emailId as string;
  const action = (body.action as string) ?? 'reply';
  const locale = (body.locale as string) ?? 'en';
  if (!emailId) return NextResponse.json({ error: 'emailId required' }, { status: 400 });

  const emailRes = await tenantTable(ctx.tenantId, 'emails').eq('id', emailId).maybeSingle();
  if (emailRes.error) throw new Error(emailRes.error.message);
  const email = emailRes.data as { from_name: string | null; from_addr: string; subject: string; content: string } | null;
  if (!email) return NextResponse.json({ error: 'Email not found' }, { status: 404 });

  const forwardHeaders = HeaderUtils.extractForwardHeaders(request.headers);
  const lang = locale === 'zh' ? '中文' : locale === 'es' ? 'Español' : 'English';
  // 客户原文语言优先（与发件人沟通保持一致）
  const mailLang = /[一-龥]/.test(email.content) ? '中文（与来信一致）' : 'the same language as the incoming email';

  if (action === 'summarize') {
    const ctxText = await getBusinessContext();
    const text = await invokeChat(
      'agent',
      [
        {
          role: 'system',
          content: `You are an AI COO assistant for a small restaurant. Reply in ${lang} with 2-4 sentences: assess this email's business value using the snapshot, then give a concrete suggested action.\n\nBusiness snapshot:\n${ctxText}`,
        },
        { role: 'user', content: `From: ${email.from_name ?? ''} <${email.from_addr}>\nSubject: ${email.subject}\n\n${email.content}` },
      ],
      forwardHeaders,
    );
    const { error: upErr } = await updateWithTenant(ctx.tenantId, 'emails', emailId, { ai_summary: text });
    if (upErr) throw new Error(upErr.message);
    return NextResponse.json({ summary: text });
  }

  // 回复草稿（流式）
  return sseResponse(
    streamChat(
      'content',
      [
        {
          role: 'system',
          content: `You are the owner of a small restaurant replying to business emails. Write the reply in ${mailLang}. Professional, warm, concrete. No subject line, no placeholder brackets — just the final reply body ready to send.`,
        },
        {
          role: 'user',
          content: `Incoming email:\nFrom: ${email.from_name ?? ''} <${email.from_addr}>\nSubject: ${email.subject}\n\n${email.content}\n\nWrite the reply.`,
        },
      ],
      forwardHeaders,
    ),
  );
}
