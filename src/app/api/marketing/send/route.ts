import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { invokeChat } from '@/lib/ai/router';
import { HeaderUtils } from 'coze-coding-dev-sdk';

interface CustomerRow {
  id: string;
  name: string;
  email: string | null;
  tags: string[];
  total_spent: string;
  visit_count: number;
  last_visit_at: string | null;
  churn_risk: string;
  preference_notes: string | null;
  created_at: string;
}

function daysSince(iso: string | null): number {
  if (!iso) return 999;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

async function selectSegment(segment: string): Promise<CustomerRow[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from('customers').select('*').not('email', 'is', null);
  if (error) throw new Error(error.message);
  const all = (data ?? []) as CustomerRow[];
  if (segment === 'high_value') return all.filter((c) => Number(c.total_spent) >= 800).sort((a, b) => Number(b.total_spent) - Number(a.total_spent));
  if (segment === 'risk') return all.filter((c) => c.churn_risk === 'high' || daysSince(c.last_visit_at) > 30);
  if (segment === 'new') return all.filter((c) => daysSince(c.created_at) <= 30);
  return all;
}

// 个性化预览：为最多 3 位客户各生成一封差异化邮件
export async function POST(request: NextRequest) {
  const body = await request.json();
  const action = (body.action as string) ?? 'preview';
  const segment = (body.segment as string) ?? 'all';
  const brief = ((body.brief as string) ?? '').trim();
  const locale = (body.locale as string) ?? 'en';

  const customers = await selectSegment(segment);
  if (customers.length === 0) return NextResponse.json({ error: 'No customers with email in this segment' }, { status: 400 });

  const supabase = getSupabaseClient();
  const { data: account } = await supabase.from('email_accounts').select('id, email, display_name, status').eq('is_default', true).maybeSingle();

  if (action === 'count') {
    return NextResponse.json({ count: customers.length, sender: account?.email ?? null });
  }

  const forwardHeaders = HeaderUtils.extractForwardHeaders(request.headers);
  const lang = locale === 'zh' ? '中文' : locale === 'es' ? 'Español' : 'English';

  const genForCustomer = async (c: CustomerRow) => {
    const text = await invokeChat(
      'content',
      [
        {
          role: 'system',
          content: `You write personalized marketing emails for a restaurant. Reply in ${lang}. Output format (plain text):
SUBJECT: <subject line>
---
<email body, 3-5 sentences, references the customer's actual visit history/preferences, warm and specific, includes a concrete offer based on the campaign brief>
PROFILE: <one short line listing which customer data points were used>
Do not use placeholders like {name} — write the final text.`,
        },
        {
          role: 'user',
          content: `Campaign brief: ${brief || 'win-back / member appreciation campaign'}\n\nCustomer profile: name=${c.name}, visits=${c.visit_count}, total_spent=$${c.total_spent}, last_visit=${daysSince(c.last_visit_at)} days ago, tags=${c.tags.join(',')}, notes=${c.preference_notes ?? 'none'}`,
        },
      ],
      forwardHeaders
    );
    return { customer: { id: c.id, name: c.name, email: c.email }, raw: text };
  };

  if (action === 'preview') {
    const sample = customers.slice(0, 3);
    const previews = await Promise.all(sample.map(genForCustomer));
    return NextResponse.json({ previews, total: customers.length, sender: account?.email ?? null });
  }

  if (action === 'send') {
    // 逐人生成 + 入队限流（每封间隔 60s）
    if (!account) return NextResponse.json({ error: 'No default email account configured' }, { status: 400 });
    let queued = 0;
    for (const c of customers) {
      try {
        const { customer, raw } = await genForCustomer(c);
        const subjectMatch = raw.match(/SUBJECT:\s*(.+)/);
        const bodyMatch = raw.split('---');
        const subject = subjectMatch?.[1]?.trim() ?? 'A message from us';
        const emailBody = (bodyMatch[1] ?? raw).replace(/PROFILE:[\s\S]*$/, '').trim();
        const { error } = await supabase.from('email_send_tasks').insert({
          account_id: account.id,
          to_addr: customer.email!,
          subject,
          content: emailBody,
          status: 'queued',
          scheduled_at: new Date(Date.now() + queued * 60000).toISOString(),
        });
        if (error) throw new Error(error.message);
        queued += 1;
      } catch {
        // 单个客户失败不阻塞整批
      }
    }
    return NextResponse.json({ queued, total: customers.length });
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}
