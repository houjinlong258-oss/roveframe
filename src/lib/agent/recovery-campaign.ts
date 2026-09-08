import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getSettings } from '@/lib/settings';
import { invokeChat } from '@/lib/ai/router';

export interface ChurnCustomer {
  id: string;
  name: string;
  email: string | null;
  total_spent: number;
  visit_count: number;
  last_visit_at: string | null;
  days_since_last_visit: number;
  churn_risk: string | null;
}

export interface RecoveryCampaignDraft {
  title: string;
  subject: string;
  body: string;
  language: string;
}

export interface CampaignExecutionMeta {
  approvalId: string;
  executionId: string;
  agentId: string;
  userId: string;
}

export interface CampaignExecutionResult {
  campaign_id: string;
  queued: number;
  skipped: number;
  recipients: { id: string; name: string; email: string }[];
  status: 'queued';
  approval_id: string;
  execution_id: string;
}

interface CustomerRow {
  id: string;
  name: string;
  email: string | null;
  total_spent: string | number | null;
  visit_count: number | null;
  last_visit_at: string | null;
  churn_risk: string | null;
}

function daysSince(iso: string | null): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

/** 纯分段逻辑（可单测）：60 天无消费 + 高价值（终身消费达标）。 */
export function selectChurnSegment(
  rows: CustomerRow[],
  opts: { daysInactive: number; minTotalSpent: number; limit: number },
): ChurnCustomer[] {
  const { daysInactive, minTotalSpent, limit } = opts;
  const candidates: ChurnCustomer[] = [];
  for (const row of rows) {
    if (!row.email) continue;
    const totalSpent = Number(row.total_spent ?? 0);
    const inactiveDays = daysSince(row.last_visit_at);
    if (inactiveDays < daysInactive) continue;
    if (minTotalSpent > 0 && totalSpent < minTotalSpent) continue;
    candidates.push({
      id: row.id,
      name: row.name,
      email: row.email,
      total_spent: totalSpent,
      visit_count: Number(row.visit_count ?? 0),
      last_visit_at: row.last_visit_at,
      days_since_last_visit: Number.isFinite(inactiveDays) ? inactiveDays : 999,
      churn_risk: row.churn_risk,
    });
  }
  candidates.sort((a, b) => b.total_spent - a.total_spent || b.visit_count - a.visit_count);
  return candidates.slice(0, Math.max(1, Math.min(limit, 500)));
}

/** 从真实 customers 表分析 60 天无消费高价值客户。 */
export async function analyzeChurnCustomers(
  tenantId: string,
  businessId: string,
  opts: { daysInactive?: number; minTotalSpent?: number; limit?: number } = {},
): Promise<ChurnCustomer[]> {
  const daysInactive = Math.max(7, Math.min(365, opts.daysInactive ?? 60));
  const minTotalSpent = Math.max(0, opts.minTotalSpent ?? 0);
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
  const { data, error } = await getSupabaseClient()
    .from('customers')
    .select('id, name, email, total_spent, visit_count, last_visit_at, churn_risk')
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .not('email', 'is', null)
    .limit(2000);
  if (error) throw new Error('churn analysis query failed: ' + error.message);
  return selectChurnSegment((data ?? []) as CustomerRow[], { daysInactive, minTotalSpent, limit });
}

/** AI 生成召回邮件草稿（失败时回落确定性模板）。 */
export async function buildCampaignDraft(
  tenantId: string,
  businessId: string,
  segment: ChurnCustomer[],
  language: string,
): Promise<RecoveryCampaignDraft> {
  const lang = language === 'zh' ? 'Chinese' : language === 'es' ? 'Spanish' : 'English';
  const profileLines = segment.slice(0, 10).map((c) =>
    '- ' + c.name + ': $' + c.total_spent.toFixed(2) + ' lifetime, ' + c.visit_count + ' visits, ' + c.days_since_last_visit + ' days since last visit',
  );
  const fallbackTitle = 'We miss you - a welcome-back treat inside';
  const fallbackBody = [
    'Hi {name},',
    '',
    "It's been a while since your last visit, and we'd love to see you again.",
    'Come back this week and enjoy a complimentary welcome-back dish with your meal.',
    '',
    'Your table is waiting.',
  ].join('\n');

  try {
    const text = await invokeChat('content', [
      {
        role: 'system',
        content: 'You are the CMO of a restaurant writing a customer recovery campaign. Reply in ' + lang + '. Output format (plain text):\nSUBJECT: <one short subject line>\n---\n<email body, 4-6 sentences, warm and personal, mentions their history, one concrete welcome-back offer. Use {name} as the greeting placeholder.>\nDo not include any other sections.',
      },
      {
        role: 'user',
        content: 'Win-back segment (' + segment.length + ' customers, sample):\n' + (profileLines.join('\n') || '(no sample)') + '\n\nWrite the campaign email.',
      },
    ], undefined, { tenantId, businessId }, { agent: 'cmo:recovery-campaign' });
    const subjectMatch = text.match(/SUBJECT:\s*(.+)/);
    const bodyMatch = text.split('---');
    const subject = subjectMatch?.[1]?.trim() ?? fallbackTitle;
    const body = (bodyMatch[1] ?? fallbackBody).trim();
    return { title: 'Customer Recovery Campaign', subject, body, language: lang };
  } catch {
    return { title: 'Customer Recovery Campaign', subject: fallbackTitle, body: fallbackBody, language: lang };
  }
}

/** 把 {name} 占位符替换为真实客户信息（发送时逐人执行）。 */
export function personalize(body: string, customer: { name: string }): string {
  return body.replace(/\{name\}/g, customer.name || 'friend');
}

/**
 * 执行冻结参数校验并真实入队召回邮件（每封一条 email_send_tasks，
 * 由 processEmailSendQueue 经真实 SMTP 出件）。
 * 幂等：同一 approval_id 重复调用直接返回已有 campaign。
 */
export async function executeRecoveryCampaign(
  tenantId: string,
  businessId: string,
  draft: { campaign_title?: unknown; subject?: unknown; body?: unknown; customer_ids?: unknown; language?: unknown },
  meta: CampaignExecutionMeta,
): Promise<CampaignExecutionResult> {
  const supabase = getSupabaseClient();
  const campaignTitle = String(draft.campaign_title ?? '').trim().slice(0, 120);
  const subject = String(draft.subject ?? '').trim().slice(0, 300);
  const body = String(draft.body ?? '').trim().slice(0, 8000);
  const customerIds = Array.isArray(draft.customer_ids)
    ? draft.customer_ids.filter((v): v is string => typeof v === 'string' && Boolean(v)).slice(0, 500)
    : [];
  if (!campaignTitle || !subject || !body || customerIds.length === 0) {
    throw new Error('Recovery campaign frozen arguments are incomplete');
  }

  const { data: existing } = await supabase.from('marketing_contents')
    .select('id')
    .eq('tenant_id', tenantId).eq('business_id', businessId)
    .eq('status', 'sending').eq('type', 'campaign')
    .eq('approval_id', meta.approvalId)
    .maybeSingle();
  if (existing) {
    const campaignId = String((existing as { id: string }).id);
    const { data: queuedRows } = await supabase.from('email_send_tasks')
      .select('id, to_addr').eq('campaign_id', campaignId)
      .eq('tenant_id', tenantId).eq('business_id', businessId);
    return {
      campaign_id: campaignId,
      queued: (queuedRows ?? []).length,
      skipped: 0,
      recipients: (queuedRows ?? []).map((r) => ({ id: '', name: '', email: String(r.to_addr) })),
      status: 'queued',
      approval_id: meta.approvalId,
      execution_id: meta.executionId,
    };
  }

  const { data: customerRows, error: customerError } = await supabase.from('customers')
    .select('id, name, email')
    .eq('tenant_id', tenantId).eq('business_id', businessId)
    .in('id', customerIds)
    .not('email', 'is', null);
  if (customerError) throw new Error('campaign recipient lookup failed: ' + customerError.message);
  const customers = (customerRows ?? []) as { id: string; name: string; email: string }[];
  if (customers.length === 0) throw new Error('No scoped customers with email match the frozen recipient list');

  const { data: campaign, error: campaignError } = await supabase.from('marketing_contents')
    .insert({
      tenant_id: tenantId, business_id: businessId,
      type: 'campaign', title: campaignTitle, brief: 'customer-recovery',
      content: body, status: 'sending', approval_id: meta.approvalId,
    })
    .select('id').single();
  if (campaignError || !campaign) throw new Error('campaign persistence failed: ' + (campaignError?.message ?? 'no row'));
  const campaignId = String((campaign as { id: string }).id);

  const now = Date.now();
  const recipients: { id: string; name: string; email: string }[] = [];
  let queued = 0;
  let skipped = 0;
  for (const customer of customers) {
    try {
      const { error } = await supabase.from('email_send_tasks').insert({
        tenant_id: tenantId, business_id: businessId,
        account_id: null,
        campaign_id: campaignId,
        approval_id: meta.approvalId,
        execution_id: meta.executionId,
        to_addr: customer.email,
        subject,
        content: personalize(body, customer),
        status: 'queued',
        scheduled_at: new Date(now + queued * 500).toISOString(),
        attempts: 0,
        max_attempts: 3,
      });
      if (error) { skipped += 1; continue; }
      recipients.push(customer);
      queued += 1;
    } catch {
      skipped += 1;
    }
  }

  return {
    campaign_id: campaignId,
    queued,
    skipped,
    recipients,
    status: 'queued',
    approval_id: meta.approvalId,
    execution_id: meta.executionId,
  };
}

/** 出件完成后回写经营记忆（真实 Memory 更新）。 */
export async function recordCampaignMemory(
  tenantId: string,
  businessId: string,
  summary: { campaignId: string; sent: number; failed: number; subject: string },
): Promise<void> {
  const content = 'Customer recovery campaign completed: subject=' + summary.subject + '; sent=' + summary.sent + '; failed=' + summary.failed + '; campaign_id=' + summary.campaignId + '.';
  const { error } = await getSupabaseClient().from('business_memories').insert({
    tenant_id: tenantId,
    business_id: businessId,
    content,
  });
  if (error) throw new Error('campaign memory write failed: ' + error.message);
}

/** 取 business 默认语言（en/zh/es）。 */
export async function businessLanguage(tenantId: string, businessId: string): Promise<string> {
  const settings = await getSettings(tenantId, businessId);
  const locale = (settings.locale ?? {}) as Record<string, unknown>;
  const lang = typeof locale.language === 'string' ? locale.language : 'en';
  return lang === 'zh' ? 'zh' : lang === 'es' ? 'es' : 'en';
}