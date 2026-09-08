/**
 * 真实外发邮件处理器：email_send_tasks 队列 → SMTP → 状态机。
 *
 * - queued → sending → sent / failed（带 attempts/backoff/last_error）
 * - 由 scheduler 每 tick 调用；也可由 API 直接触发
 * - 活动收尾：campaign 全部出件完成后回写 marketing_contents.status、
 *   agent_approvals.execution_result 与 business_memories。
 */
import nodemailer from 'nodemailer';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { decrypt } from '@/lib/crypto';
import { recordCampaignMemory } from '@/lib/agent/recovery-campaign';

interface EmailAccountRow {
  id: string;
  email: string;
  display_name: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  credentials_encrypted: string | null;
}

interface OutgoingTaskRow {
  id: string;
  tenant_id: string;
  business_id: string;
  account_id: string | null;
  campaign_id: string | null;
  approval_id: string | null;
  execution_id: string | null;
  to_addr: string;
  subject: string;
  content: string;
  attempts: number | null;
  max_attempts: number | null;
}

interface SmtpCredentials {
  smtp_user?: string;
  smtp_pass?: string;
}

async function loadDefaultAccount(tenantId: string, businessId: string, accountId: string | null): Promise<EmailAccountRow | null> {
  const supabase = getSupabaseClient();
  let query = supabase.from('email_accounts')
    .select('id, email, display_name, smtp_host, smtp_port, credentials_encrypted')
    .eq('tenant_id', tenantId).eq('business_id', businessId).eq('status', 'active');
  query = accountId
    ? query.eq('id', accountId)
    : query.eq('is_default', true);
  const { data, error } = await query.maybeSingle();
  if (error || !data) return null;
  const row = data as EmailAccountRow;
  return row.smtp_host && row.credentials_encrypted ? row : null;
}

async function sendViaSmtp(account: EmailAccountRow, to: string, subject: string, content: string): Promise<string> {
  const host = account.smtp_host;
  if (!host) throw new Error('SMTP host is not configured');
  let creds: SmtpCredentials = {};
  try {
    creds = JSON.parse(decrypt(account.credentials_encrypted ?? '')) as SmtpCredentials;
  } catch {
    throw new Error('SMTP credentials could not be decrypted');
  }
  const transport = nodemailer.createTransport({
    host,
    port: account.smtp_port ?? 465,
    secure: (account.smtp_port ?? 465) === 465,
    auth: { user: creds.smtp_user ?? account.email, pass: creds.smtp_pass ?? '' },
  });
  const info = await transport.sendMail({
    from: account.display_name
      ? '"' + account.display_name + '" <' + account.email + '>'
      : account.email,
    to,
    subject,
    text: content,
  });
  return String(info.messageId ?? '');
}

function backoff(attempts: number): number {
  return Math.min(60, 2 ** Math.max(0, attempts - 1));
}

/**
 * 出件主循环：认领到期任务 → 真实 SMTP 发送 → 状态回写。
 * 返回本轮处理统计。
 */
export async function processEmailSendQueue(limit = 20): Promise<{ processed: number; sent: number; failed: number; requeued: number }> {
  const supabase = getSupabaseClient();
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase.from('email_send_tasks')
    .select('*')
    .eq('status', 'queued')
    .lte('scheduled_at', nowIso)
    .order('created_at', { ascending: true })
    .limit(Math.max(1, Math.min(limit, 50)));
  if (error) throw new Error('email send queue claim failed: ' + error.message);
  const tasks = (data ?? []) as OutgoingTaskRow[];

  let sent = 0;
  let failed = 0;
  let requeued = 0;
  const touchedCampaigns = new Set<string>();

  for (const task of tasks) {
    const attempts = Number(task.attempts ?? 0);
    const maxAttempts = Number(task.max_attempts ?? 3);
    // CAS：仅当仍为 queued 时认领，避免多 worker 重复发送。
    const { data: claimed, error: claimError } = await supabase.from('email_send_tasks')
      .update({ status: 'sending', claimed_at: nowIso })
      .eq('id', task.id)
      .eq('tenant_id', task.tenant_id)
      .eq('business_id', task.business_id)
      .eq('status', 'queued')
      .select('id').maybeSingle();
    if (claimError || !claimed) continue;

    if (task.campaign_id) touchedCampaigns.add(task.campaign_id);
    try {
      const account = await loadDefaultAccount(task.tenant_id, task.business_id, task.account_id);
      if (!account) throw new Error('No active SMTP email account configured for this business');
      const messageId = await sendViaSmtp(account, task.to_addr, task.subject, task.content);
      await supabase.from('email_send_tasks')
        .update({ status: 'sent', sent_at: nowIso, provider_message_id: messageId || null, attempts: attempts + 1, error: null })
        .eq('id', task.id)
        .eq('tenant_id', task.tenant_id)
        .eq('business_id', task.business_id);
      sent += 1;
    } catch (sendError) {
      const message = sendError instanceof Error ? sendError.message : String(sendError);
      const nextAttempts = attempts + 1;
      if (nextAttempts >= maxAttempts) {
        await supabase.from('email_send_tasks')
          .update({ status: 'failed', last_error: message, error: message, attempts: nextAttempts, failed_at: nowIso })
          .eq('id', task.id)
          .eq('tenant_id', task.tenant_id)
          .eq('business_id', task.business_id);
        failed += 1;
      } else {
        await supabase.from('email_send_tasks')
          .update({
            status: 'queued',
            last_error: message,
            attempts: nextAttempts,
            scheduled_at: new Date(Date.now() + backoff(nextAttempts) * 60_000).toISOString(),
          })
          .eq('id', task.id)
          .eq('tenant_id', task.tenant_id)
          .eq('business_id', task.business_id);
        requeued += 1;
      }
    }
  }

  // 活动收尾：campaign 内无剩余 queued/sending 即完成。
  for (const campaignId of touchedCampaigns) {
    await finalizeCampaignIfComplete(campaignId);
  }
  return { processed: tasks.length, sent, failed, requeued };
}

interface CampaignRow {
  id: string;
  tenant_id: string;
  business_id: string;
  approval_id: string | null;
}

/** 全部出件完成后：活动置 sent + 审批 execution_result 回写 + Memory 沉淀。 */
export async function finalizeCampaignIfComplete(campaignId: string): Promise<void> {
  const supabase = getSupabaseClient();
  const { data: campaign, error: campaignError } = await supabase.from('marketing_contents')
    .select('id, tenant_id, business_id, approval_id, status')
    .eq('id', campaignId).maybeSingle();
  if (campaignError || !campaign) return;
  const row = campaign as CampaignRow & { status: string };
  if (row.status === 'sent') return;

  const { data: pending, error: pendingError } = await supabase.from('email_send_tasks')
    .select('id, status', { count: 'exact' })
    .eq('campaign_id', campaignId)
    .eq('tenant_id', row.tenant_id)
    .eq('business_id', row.business_id)
    .in('status', ['queued', 'sending']);
  if (pendingError || (pending && pending.length > 0)) return;

  const { count: sentCount } = await supabase.from('email_send_tasks')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .eq('tenant_id', row.tenant_id).eq('business_id', row.business_id)
    .eq('status', 'sent');
  const { count: failedCount } = await supabase.from('email_send_tasks')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .eq('tenant_id', row.tenant_id).eq('business_id', row.business_id)
    .eq('status', 'failed');
  const sentTotal = sentCount ?? 0;
  const failedTotal = failedCount ?? 0;

  await supabase.from('marketing_contents')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('id', campaignId)
    .eq('tenant_id', row.tenant_id)
    .eq('business_id', row.business_id);

  const { data: subjectRow } = await supabase.from('email_send_tasks')
    .select('subject').eq('campaign_id', campaignId)
    .eq('tenant_id', row.tenant_id).eq('business_id', row.business_id)
    .limit(1).maybeSingle();
  const subject = String((subjectRow as { subject?: string } | null)?.subject ?? 'Recovery campaign');

  const finalResult = {
    campaign_id: campaignId,
    status: 'completed',
    sent: sentTotal,
    failed: failedTotal,
    completed_at: new Date().toISOString(),
  };
  if (row.approval_id) {
    await supabase.from('agent_approvals')
      .update({ execution_result: finalResult, updated_at: new Date().toISOString() })
      .eq('id', row.approval_id)
      .eq('tenant_id', row.tenant_id)
      .eq('business_id', row.business_id);
  }
  try {
    await recordCampaignMemory(row.tenant_id, row.business_id, {
      campaignId, sent: sentTotal, failed: failedTotal, subject,
    });
  } catch (memoryError) {
    console.error('[email/outgoing] campaign memory write failed:', memoryError instanceof Error ? memoryError.message : String(memoryError));
  }
}