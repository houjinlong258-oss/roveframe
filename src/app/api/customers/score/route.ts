import { NextRequest, NextResponse } from 'next/server';
import { streamChat } from '@/lib/ai/router';
import { sseResponse } from '@/lib/api-helpers';
import { getTenantContext } from '@/lib/tenant';
import { scopedTable, updateWithScope } from '@/lib/tenant-db';
import { HeaderUtils } from 'coze-coding-dev-sdk';
import { protectBusinessMutation } from '@/lib/mutation-guard';

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

async function scoreOrPlanRetention(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const mode = (body.mode as string) ?? 'retention';
  const ctx = await getTenantContext(request);

  if (mode === 'score') {
    // 批量 AI 评分：基于消费行为启发式 + AI 解释
    const rowsRes = await scopedTable(ctx, 'customers');
    if (rowsRes.error) throw new Error(rowsRes.error.message);
    const list = (rowsRes.data ?? []) as CustomerRow[];

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
      const { error: upErr } = await updateWithScope(ctx, 'customers', s.id, {
        ai_score: s.ai_score,
        churn_risk: s.churn_risk,
      });
      if (upErr) throw new Error(upErr.message);
    }
    return NextResponse.json({ scored: scored.length });
  }

  // 单个客户挽留方案（流式）
  const customerId = body.customerId as string;
  if (!customerId) return NextResponse.json({ error: 'customerId required' }, { status: 400 });
  const cRes = await scopedTable(ctx, 'customers').eq('id', customerId).maybeSingle();
  if (cRes.error) throw new Error(cRes.error.message);
  const c = cRes.data as CustomerRow | null;
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
      forwardHeaders,
      { tenantId: ctx.tenantId, businessId: ctx.businessId, userId: ctx.userId },
    ),
  );
}

export const POST = protectBusinessMutation(
  { permission: 'customers:write', action: 'customers.score_or_retain', entity: 'customers' },
  scoreOrPlanRetention,
);
