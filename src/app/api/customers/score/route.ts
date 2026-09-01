import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { streamChat } from '@/lib/ai/router';
import { sseResponse } from '@/lib/api-helpers';
import { HeaderUtils } from 'coze-coding-dev-sdk';

interface CustomerRow {
  id: string;
  name: string;
  tags: string[];
  total_spent: string;
  visit_count: number;
  last_visit_at: string | null;
  churn_risk: string;
  preference_notes: string | null;
}

function daysSince(iso: string | null): number {
  if (!iso) return 999;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const mode = (body.mode as string) ?? 'retention';
  const supabase = getSupabaseClient();

  if (mode === 'score') {
    // 批量 AI 评分：基于消费行为启发式 + AI 解释
    const { data: rows, error } = await supabase.from('customers').select('*');
    if (error) throw new Error(error.message);
    const list = (rows ?? []) as CustomerRow[];

    const scored = list.map((c) => {
      const days = daysSince(c.last_visit_at);
      const recency = Math.max(0, 40 - Math.min(days, 40));
      const freq = Math.min(c.visit_count, 40);
      const monetary = Math.min(Number(c.total_spent) / 100, 20);
      const score = Math.round(Math.min(98, Math.max(8, recency + freq + monetary)));
      const churn = days > 45 ? 'high' : days > 25 || score < 45 ? 'medium' : 'low';
      return { id: c.id, ai_score: score, churn_risk: churn };
    });

    for (const s of scored) {
      const { error: upErr } = await supabase
        .from('customers')
        .update({ ai_score: s.ai_score, churn_risk: s.churn_risk })
        .eq('id', s.id);
      if (upErr) throw new Error(upErr.message);
    }
    return NextResponse.json({ scored: scored.length });
  }

  // 单个客户挽留方案（流式）
  const customerId = body.customerId as string;
  if (!customerId) return NextResponse.json({ error: 'customerId required' }, { status: 400 });
  const { data: c, error } = await supabase.from('customers').select('*').eq('id', customerId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!c) return NextResponse.json({ error: 'Customer not found' }, { status: 404 });

  const forwardHeaders = HeaderUtils.extractForwardHeaders(request.headers);
  const locale = (body.locale as string) ?? 'en';
  const lang = locale === 'zh' ? '中文' : locale === 'es' ? 'Español' : 'English';

  return sseResponse(
    streamChat(
      'content',
      [
        {
          role: 'system',
          content: `You are a customer-retention expert for a small restaurant. Reply in ${lang} with concise markdown: 1) why the customer is at risk, 2) a tailored win-back offer, 3) a ready-to-send message (SMS/email) written in the customer's own language based on their name. Keep it under 220 words.`,
        },
        {
          role: 'user',
          content: `Customer: ${c.name}. Tags: ${(c.tags as string[]).join(', ')}. Total spent: $${c.total_spent}. Visits: ${c.visit_count}. Last visit: ${daysSince(c.last_visit_at)} days ago. Churn risk: ${c.churn_risk}. Preference notes: ${c.preference_notes ?? 'none'}.`,
        },
      ],
      forwardHeaders
    )
  );
}
