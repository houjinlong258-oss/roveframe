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

export async function loadDefaultAccount(tenantId: string, businessId: string, accountId: string | null): Promise<EmailAccountRow | null> {
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

/** P0-15：sending 租约超时（默认 15 分钟）——崩溃残留行必须被回收，否则任务/活动永久卡死。 */
export const EMAIL_SEND_LEASE_TIMEOUT_MS = 15 * 60_000;

export interface LeaseRecoveryDecision {
  action: 'requeue' | 'fail' | 'none';
  nextAttempts: number;
}

/** 纯决策：sending 行超过租约后 requeue（attempts+1）；超过 max_attempts 转 failed。 */
export function emailLeaseDecision(
  row: { status: string; claimed_at: string | null; attempts: number | null; max_attempts: number | null },
  nowMs: number,
  leaseMs = EMAIL_SEND_LEASE_TIMEOUT_MS,
): LeaseRecoveryDecision {
  if (row.status !== 'sending' || !row.claimed_at) return { action: 'none', nextAttempts: Number(row.attempts ?? 0) };
  const claimedAt = new Date(row.claimed_at).getTime();
  if (Number.isNaN(claimedAt) || nowMs - claimedAt < leaseMs) return { action: 'none', nextAttempts: Number(row.attempts ?? 0) };
  const nextAttempts = Number(row.attempts ?? 0) + 1;
  const maxAttempts = Number(row.max_attempts ?? 3);
  return nextAttempts >= maxAttempts
    ? { action: 'fail', nextAttempts }
    : { action: 'requeue', nextAttempts };
}

/**
 * P0-15：回收崩溃残留的 sending 行（租约过期 → queued 重发 / failed）。
 * 每次出件主循环前调用；返回回收统计。
 */
export async function recoverStaleEmailSends(): Promise<{ requeued: number; failed: number }> {
  const supabase = getSupabaseClient();
  const cutoffIso = new Date(Date.now() - EMAIL_SEND_LEASE_TIMEOUT_MS).toISOString();
  const { data, error } = await supabase.from('email_send_tasks')
    .select('id, tenant_id, business_id, status, claimed_at, attempts, max_attempts')
    .eq('status', 'sending')
    .lte('claimed_at', cutoffIso)
    .limit(100);
  if (error) {
    console.error('[email/outgoing] stale send recovery lookup failed:', error.message);
    return { requeued: 0, failed: 0 };
  }
  let requeued = 0;
  let failed = 0;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  for (const raw of data ?? []) {
    const row = raw as typeof raw & { status: string; claimed_at: string | null; attempts: number | null; max_attempts: number | null };
    const decision = emailLeaseDecision(row, nowMs);
    if (decision.action === 'none') continue;
    const patch = decision.action === 'fail'
      ? {
          status: 'failed',
          attempts: decision.nextAttempts,
          failed_at: nowIso,
          last_error: 'email send lease expired; recovered as failed',
          claimed_at: null,
        }
      : {
          status: 'queued',
          attempts: decision.nextAttempts,
          scheduled_at: nowIso,
          last_error: 'email send lease expired; requeued',
          claimed_at: null,
        };
    const { error: updateError } = await supabase.from('email_send_tasks')
      .update(patch)
      .eq('id', row.id)
      .eq('tenant_id', row.tenant_id)
      .eq('business_id', row.business_id)
      .eq('status', 'sending')
      .eq('claimed_at', row.claimed_at as string);
    if (updateError) continue;
    if (decision.action === 'fail') failed += 1;
    else requeued += 1;
  }
  return { requeued, failed };
}

/**
 * 用 business 默认发件账号真实发送一封邮件（供通知/营销等复用）。
 * 返回 provider message id。
 */
export async function sendEmailWithDefaultAccount(
  tenantId: string,
  businessId: string,
  to: string,
  subject: string,
  text: string,
): Promise<string> {
  const account = await loadDefaultAccount(tenantId, businessId, null);
  if (!account) throw new Error('No active SMTP email account configured for this business');
  return sendViaSmtp(account, to, subject, text);
}

/**
 * 出件主循环：认领到期任务 → 真实 SMTP 发送 → 状态回写。
 * 返回本轮处理统计。
 */
export async function processEmailSendQueue(limit = 20): Promise<{ processed: number; sent: number; failed: number; requeued: number }> {
  const supabase = getSupabaseClient();
  const nowIso = new Date().toISOString();

  // P0-15：先回收崩溃残留的 sending 行，避免任务永久卡死 / 活动永不 sent。
  await recoverStaleEmailSends();

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
      const { error: sentUpdateError } = await supabase.from('email_send_tasks')
        .update({ status: 'sent', sent_at: nowIso, provider_message_id: messageId || null, attempts: attempts + 1, error: null })
        .eq('id', task.id)
        .eq('tenant_id', task.tenant_id)
        .eq('business_id', task.business_id);
      if (sentUpdateError) {
        // SMTP 已送达但状态回写失败：租约恢复兜底（15min 后 requeue 可能重发，
        // 属 at-least-once 语义；错误必须留痕）。
        console.error('[email/outgoing] sent status write-back failed:', sentUpdateError.message);
      }
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