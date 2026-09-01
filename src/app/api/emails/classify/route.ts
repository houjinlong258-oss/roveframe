import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { streamChat, invokeChat } from '@/lib/ai/router';
import { getBusinessContext } from '@/lib/business-context';
import { sseResponse } from '@/lib/api-helpers';
import { HeaderUtils } from 'coze-coding-dev-sdk';

// AI 处理邮件：summarize=生成摘要 / reply=生成回复草稿（流式）
export async function POST(request: NextRequest) {
  const body = await request.json();
  const emailId = body.emailId as string;
  const action = (body.action as string) ?? 'reply';
  const locale = (body.locale as string) ?? 'en';
  if (!emailId) return NextResponse.json({ error: 'emailId required' }, { status: 400 });

  const supabase = getSupabaseClient();
  const { data: email, error } = await supabase.from('emails').select('*').eq('id', emailId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!email) return NextResponse.json({ error: 'Email not found' }, { status: 404 });

  const forwardHeaders = HeaderUtils.extractForwardHeaders(request.headers);
  const lang = locale === 'zh' ? '中文' : locale === 'es' ? 'Español' : 'English';
  // 客户原文语言优先（与发件人沟通保持一致）
  const mailLang = /[\u4e00-\u9fff]/.test(email.content) ? '中文（与来信一致）' : 'the same language as the incoming email';

  if (action === 'summarize') {
    const ctx = await getBusinessContext();
    const text = await invokeChat(
      'agent',
      [
        {
          role: 'system',
          content: `You are an AI COO assistant for a small restaurant. Reply in ${lang} with 2-4 sentences: assess this email's business value using the snapshot, then give a concrete suggested action.\n\nBusiness snapshot:\n${ctx}`,
        },
        { role: 'user', content: `From: ${email.from_name ?? ''} <${email.from_addr}>\nSubject: ${email.subject}\n\n${email.content}` },
      ],
      forwardHeaders
    );
    const { error: upErr } = await supabase.from('emails').update({ ai_summary: text }).eq('id', emailId);
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
      forwardHeaders
    )
  );
}
