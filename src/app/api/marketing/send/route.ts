import { NextRequest, NextResponse } from 'next/server';
import { invokeChat } from '@/lib/ai/router';
import { getTenantContext, requireBusinessContext } from '@/lib/tenant';
import { insertWithScope, scopedTable } from '@/lib/tenant-db';
import { HeaderUtils } from 'coze-coding-dev-sdk';
import { protectBusinessMutation, type BusinessMutationContext } from '@/lib/mutation-guard';
import { checkFixedWindow, rateLimitResponse } from '@/lib/rate-limit';
import { pickUsableAccount, type EmailAccountCandidate } from '@/lib/email/eligibility';
import {
  generateUnsubscribeToken,
  unsubscribePageUrlFor,
} from '@/lib/email/unsubscribe';
import { resolveAppOrigin } from '@/lib/app-origin';

/**
 * 单次"发送"请求里最多处理多少位收件人。
 *
 * Phase 16 任务 4：原实现对**整个名单**串行做逐人 LLM 生成（真实名单必然超时），
 * 且中途失败时已生成的收件人不会被记账，用户看到的是"点了没反应"。
 *
 * 把这个上限显式化有两个作用：
 *   1. 请求时长有界（每封约一次 LLM 往返）；
 *   2. 返回值如实告诉调用方"本次处理了 N / 共 M"，剩下的需要再点一次或分批，
 *      而不是假装全部完成。
 *
 * 真正的解法是把生成搬到 worker（见报告"仍未做"一节）：出件队列
 * `email_send_tasks` 与 scheduler 已经就绪，但逐人 LLM 生成需要把模型上下文
 * 一起入队，属下一阶段改动，本轮**不做**，如实记录。
 */
const MAX_RECIPIENTS_PER_REQUEST = 25;

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

async function selectSegment(ctx: BusinessMutationContext, segment: string): Promise<CustomerRow[]> {
  const res = await scopedTable(ctx, 'customers', '*')
    .not('email', 'is', null);
  if (res.error) throw new Error(res.error.message);
  const all = (res.data ?? []) as CustomerRow[];
  if (segment === 'high_value') return all.filter((c) => Number(c.total_spent) >= 800).sort((a, b) => Number(b.total_spent) - Number(a.total_spent));
  if (segment === 'risk') return all.filter((c) => c.churn_risk === 'high' || daysSince(c.last_visit_at) > 30);
  if (segment === 'new') return all.filter((c) => daysSince(c.created_at) <= 30);
  return all;
}

// 个性化预览：为最多 3 位客户各生成一封差异化邮件
async function prepareOrSendMarketing(request: NextRequest) {
  const ctx = requireBusinessContext(await getTenantContext(request));

  // P0-1：营销生成/发送限流 —— 每商户 10 次/分钟（逐人 LLM 生成成本高）。
  const limit = checkFixedWindow(
    `marketing:send:${ctx.tenantId}:${ctx.businessId}`,
    { limit: 10, windowMs: 60_000 },
  );
  if (!limit.ok) return rateLimitResponse(limit);

  const body = await request.json();
  const action = (body.action as string) ?? 'preview';
  const segment = (body.segment as string) ?? 'all';
  const brief = ((body.brief as string) ?? '').trim();
  const locale = (body.locale as string) ?? 'en';

  const customers = await selectSegment(ctx, segment);
  if (customers.length === 0) return NextResponse.json({ error: 'No customers with email in this segment' }, { status: 400 });

  // Phase 16 任务 4：账号判定改用与 worker **同一个**函数。
  // 原实现只查 is_default ⇒ UI 显示可用，而 worker 还要求 status='active'
  // 且 smtp_host / credentials_encrypted 齐备 ⇒ 按钮能点，但每封都失败。
  const accountRes = await scopedTable(ctx, 'email_accounts', 'id, email, display_name, status, smtp_host, smtp_port, credentials_encrypted, is_default')
    .eq('is_default', true)
    .maybeSingle();
  const candidate = (accountRes.data ?? null) as EmailAccountCandidate | null;
  const picked = pickUsableAccount(candidate ? [candidate] : []);
  const account = picked.account;

  if (action === 'count') {
    return NextResponse.json({
      count: customers.length,
      sender: candidate?.email ?? null,
      // 如实告诉 UI 这个账号**现在能不能发**，而不是"有个默认账号就算能用"
      canSend: picked.eligibility.usable,
      blockedReason: picked.eligibility.reason,
      blockedMessage: picked.eligibility.message,
    });
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
      forwardHeaders,
      { tenantId: ctx.tenantId, businessId: ctx.businessId, userId: ctx.userId },
    );
    return { customer: { id: c.id, name: c.name, email: c.email }, raw: text };
  };

  if (action === 'preview') {
    const sample = customers.slice(0, 3);
    const previews = await Promise.all(sample.map(genForCustomer));
    return NextResponse.json({ previews, total: customers.length, sender: account?.email ?? null });
  }

  if (action === 'send') {
    if (!account) {
      // fail-closed 且**说明原因**：按钮可用但发不出去是上一版最糟的行为
      return NextResponse.json(
        {
          error: picked.eligibility.message,
          code: picked.eligibility.reason ?? 'no_usable_account',
        },
        { status: 400 },
      );
    }
    const batch = customers.slice(0, MAX_RECIPIENTS_PER_REQUEST);
    const origin = resolveAppOrigin(request);
    let queued = 0;
    for (const [index, c] of batch.entries()) {
      try {
        const { customer, raw } = await genForCustomer(c);
        const subjectMatch = raw.match(/SUBJECT:\s*(.+)/);
        const bodyMatch = raw.split('---');
        const subject = subjectMatch?.[1]?.trim() ?? 'A message from us';
        const emailBody = (bodyMatch[1] ?? raw).replace(/PROFILE:[\s\S]*$/, '').trim();
        // 退订令牌在**入队时**定稿并随任务落库：出件是异步的，
        // 发送时现算会让同一封信的重试换掉令牌，旧链接失效。
        const token = generateUnsubscribeToken();
        const { error } = await insertWithScope(ctx, 'email_send_tasks', {
          account_id: account.id,
          to_addr: customer.email!,
          subject,
          content: emailBody,
          status: 'queued',
          scheduled_at: new Date(Date.now() + index * 60000).toISOString(),
          unsubscribe_token: token,
          unsubscribe_url: unsubscribePageUrlFor(origin, locale, token),
        });
        if (error) throw new Error(error.message);
        queued += 1;
      } catch (error) {
        console.error('[marketing/send] customer generation or queueing failed', {
          customerId: c.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // 一并给出退订入口的形状，便于核对两种入口（页面 / 一键 POST）指向同一令牌
    return NextResponse.json({
      queued,
      total: customers.length,
      processedThisRequest: batch.length,
      remaining: Math.max(0, customers.length - batch.length),
      unsubscribe: {
        linkShape: unsubscribePageUrlFor(origin, locale, '<per-email-token>'),
        note: 'Each queued email carries its own token; List-Unsubscribe + List-Unsubscribe-Post are set at send time.',
      },
    });
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}

export const POST = protectBusinessMutation(
  { permission: 'marketing:send', action: 'marketing.send', entity: 'marketing_campaign' },
  prepareOrSendMarketing,
);
