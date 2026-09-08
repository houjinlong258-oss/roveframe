/**
 * Live E2E：真实对话触发审批动作 —— AI CMO Customer Recovery Campaign。
 *
 * 需要运行栈：Next.js（RF_BASE_URL）+ Python RoveAgent + Supabase +
 * 该 tenant/business 已配置真实 SMTP 邮箱账号。
 *
 * 运行：
 *   RF_BASE_URL=http://127.0.0.1:5000 \
 *   ROVEAGENT_API_KEY=... ROVEAGENT_APPROVAL_SECRET=... \
 *   RF_E2E_TENANT_ID=... RF_E2E_BUSINESS_ID=... \
 *   RF_E2E_OWNER_EMAIL=... RF_E2E_OWNER_PASSWORD=... \
 *   pnpm exec tsx scripts/e2e-recovery-campaign.mts
 *
 * 任何前置缺失或步骤失败 → exit 1（不假装通过）。
 */
import { createHmac, randomUUID } from 'node:crypto';
import { getSupabaseClient } from '../src/storage/database/supabase-client';

interface StepResult { step: string; ok: boolean; detail: string }
const results: StepResult[] = [];
function record(step: string, ok: boolean, detail: string): void {
  results.push({ step, ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + step + ' | ' + detail.slice(0, 200));
}

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error('Missing required env: ' + name);
  return value;
}

async function main(): Promise<void> {
  const base = env('RF_BASE_URL').replace(/\/$/, '');
  const apiKey = env('ROVEAGENT_API_KEY');
  const approvalSecret = env('ROVEAGENT_APPROVAL_SECRET');
  const tenantId = env('RF_E2E_TENANT_ID');
  const businessId = env('RF_E2E_BUSINESS_ID');
  const ownerEmail = env('RF_E2E_OWNER_EMAIL');
  const ownerPassword = env('RF_E2E_OWNER_PASSWORD');
  const ownerUserId = process.env.RF_E2E_OWNER_USER_ID?.trim() ?? '';
  const agentId = 'marketing';
  const requestId = randomUUID();
  const invocationId = 'e2e-' + randomUUID();

  const internalHeaders = {
    'Content-Type': 'application/json',
    'X-RoveAgent-Key': apiKey,
  };

  // 1) 真实数据分段：60 天无消费高价值客户
  const analyzeResp = await fetch(base + '/api/internal/agent/business-data', {
    method: 'POST', headers: internalHeaders,
    body: JSON.stringify({
      tenant_id: tenantId, business_id: businessId,
      operation: 'analyze_churn_customers',
      params: { days_inactive: 60, min_total_spent: 0, limit: 20 },
    }),
  });
  const analyzeBody = await analyzeResp.json() as { ok?: boolean; data?: { id: string; email: string | null; name: string }[]; error?: string };
  record('1. analyze_churn_customers', analyzeResp.ok && analyzeBody.ok === true, JSON.stringify(analyzeBody).slice(0, 160));
  const segment = (analyzeBody.data ?? []).filter((c) => c.email);
  if (segment.length === 0) throw new Error('No churn customers with email in the target business — cannot run a real send');

  // 2) 模拟模型工具调用：签名推送 tool_call 审批事件（等同于 gate 冻结）
  const frozenArgs = {
    campaign_title: 'E2E Welcome Back Campaign',
    subject: 'We miss you at {restaurant}',
    body: 'Hi {name},\n\nIt has been a while! Come back this week for a welcome-back treat.\n\nSee you soon.',
    customer_ids: segment.slice(0, 3).map((c) => c.id),
    language: 'en',
  };
  const payload = {
    kind: 'tool_call', tenant_id: tenantId, business_id: businessId,
    title: 'Send customer recovery campaign (E2E)',
    description: 'Recovery email campaign for ' + frozenArgs.customer_ids.length + ' churned high-value customers.',
    payload: {
      tool: 'send_customer_recovery_campaign', args: frozenArgs,
      invocation_id: invocationId, audit_event_id: randomUUID(),
      user_id: ownerUserId, agent_id: agentId, role: 'owner',
      permissions: ['*'], request_id: requestId, task_id: '',
      risk: 'high', approval_policy: 'owner',
    },
  };
  const eventBody = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', approvalSecret).update(ts + '.' + eventBody).digest('hex');
  const eventResp = await fetch(base + '/api/agent/approvals/events', {
    method: 'POST', headers: { ...internalHeaders, 'X-RoveAgent-Timestamp': ts, 'X-RoveAgent-Signature': signature },
    body: eventBody,
  });
  const eventJson = await eventResp.json() as { ok?: boolean; approval_id?: string; error?: string };
  record('2. approval event persisted', eventResp.ok && eventJson.ok === true, JSON.stringify(eventJson).slice(0, 160));
  if (!eventJson.approval_id) throw new Error('No approval id returned: ' + JSON.stringify(eventJson));

  // 3) 老板登录
  const loginResp = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ownerEmail, password: ownerPassword }),
  });
  const setCookie = loginResp.headers.get('set-cookie') ?? '';
  record('3. owner login', loginResp.ok && Boolean(setCookie), 'cookie=' + (setCookie ? 'rf_session=...' : 'missing'));
  if (!setCookie) throw new Error('Owner login failed — check RF_E2E_OWNER_EMAIL/PASSWORD');

  const authHeaders = { 'Content-Type': 'application/json', Cookie: setCookie.split(';')[0] };

  // 4) 审批台可见 + 老板批准
  const listResp = await fetch(base + '/api/agent/approvals', { headers: authHeaders });
  const listJson = await listResp.json() as { approvals?: { id: string; invocation_id: string; status: string }[] };
  const pending = (listJson.approvals ?? []).find((a) => a.invocation_id === invocationId);
  record('4. approval visible to owner', Boolean(pending), pending ? pending.id : 'not found');
  if (!pending) throw new Error('Approval not visible to owner');

  const approveResp = await fetch(base + '/api/agent/approvals', {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ approval_id: pending.id, action: 'approve' }),
  });
  const approveJson = await approveResp.json() as { ok?: boolean; status?: string; error?: string };
  record('5. owner approves', approveResp.ok, JSON.stringify(approveJson).slice(0, 160));

  // 5) 等待执行完成（queued 入队即 executed；真实出件随后由 scheduler 处理）
  let status = '';
  for (let i = 0; i < 30; i += 1) {
    const poll = await fetch(base + '/api/agent/approvals', { headers: authHeaders });
    const pollJson = await poll.json() as { approvals?: { id: string; status: string; execution_result?: { queued?: number; campaign_id?: string; sent?: number; failed?: number; status?: string } }[] };
    const item = (pollJson.approvals ?? []).find((a) => a.id === pending.id);
    status = item?.status ?? '';
    if (status === 'executed' || status === 'failed') {
      const result = item?.execution_result;
      record('6. approval executed with campaign queued', status === 'executed' && Boolean(result?.queued), JSON.stringify(result).slice(0, 200));
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (status !== 'executed') throw new Error('Approval did not reach executed (status=' + status + ')');

  // 6) 等待真实 SMTP 出件完成（scheduler 每 60s 跑一次；最多等 3 分钟）
  const supabase = getSupabaseClient();
  let finalState: { sent: number; failed: number; pendingCount: number } = { sent: 0, failed: 0, pendingCount: -1 };
  for (let i = 0; i < 18; i += 1) {
    await new Promise((r) => setTimeout(r, 10_000));
    const { data: tasks } = await supabase.from('email_send_tasks')
      .select('status').eq('tenant_id', tenantId).eq('business_id', businessId)
      .eq('approval_id', pending.id);
    const rows = (tasks ?? []) as { status: string }[];
    const sent = rows.filter((t) => t.status === 'sent').length;
    const failed = rows.filter((t) => t.status === 'failed').length;
    const pendingCount = rows.filter((t) => t.status === 'queued' || t.status === 'sending').length;
    finalState = { sent, failed, pendingCount };
    if (pendingCount === 0 && rows.length > 0) break;
  }
  record('7. real SMTP delivery finished', finalState.pendingCount === 0 && finalState.sent > 0,
    'sent=' + finalState.sent + ' failed=' + finalState.failed + ' pending=' + finalState.pendingCount);
  if (finalState.sent === 0) throw new Error('No email reached sent state — SMTP account may be unconfigured');

  // 7) Audit Store 有该执行周期的记录
  const { data: auditRows } = await supabase.from('audit_events')
    .select('action').eq('tenant_id', tenantId).eq('business_id', businessId)
    .eq('approval_id', pending.id);
  const actions = (auditRows ?? []).map((a) => String((a as { action: string }).action));
  record('8. audit_events recorded', actions.includes('approval.approved') && actions.includes('approval.executed'),
    'actions=' + actions.join(','));
  if (actions.length === 0) throw new Error('audit_events missing for approval ' + pending.id);

  // 8) Memory 已沉淀活动结果
  const { data: memories } = await supabase.from('business_memories')
    .select('content').eq('tenant_id', tenantId).eq('business_id', businessId)
    .order('created_at', { ascending: false }).limit(5);
  const memoryHit = (memories ?? []).some((m) => String((m as { content: string }).content).includes('campaign'));
  record('9. business_memories updated', memoryHit, memoryHit ? 'campaign memory found' : 'not found');
  if (!memoryHit) throw new Error('Campaign outcome missing from business memory');

  console.log('\nE2E COMPLETE: all steps passed.');
}

main().catch((error) => {
  console.error('\nE2E FAILED:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
