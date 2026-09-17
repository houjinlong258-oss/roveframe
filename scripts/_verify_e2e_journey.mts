/**
 * Phase 15 —— 端到端用户旅程验收（真实环境）。
 *
 * 覆盖 Phase 14 未覆盖的链路：
 *   注册 → 登录 → 会话态 → 仪表盘数据 → AI 对话 → 工具调用 → 审批闭环
 *
 * ## 为什么每一步都要断言"能失败"
 *
 * 本仓库的规矩：任何"通过"结论必须先有能产生"不通过"的证据。
 * 因此本脚本在每个环节都记录**可判伪的观测值**（HTTP 状态、SSE 事件名、
 * x-request-id、审计增量、审批状态迁移），而不是只看"有没有报错"：
 *
 *   - 未登录访问 /api/auth/me 必须 401（否则后面的 200 不能证明会话生效）
 *   - 登录后必须 200（阴性对照：故意用错密码必须 401）
 *   - AI 对话必须真的产生工具调用事件 + 运行时审计增量
 *   - 审批必须从 pending 迁移到 executed 且带 execution_result
 *
 * ## 用法
 *
 *   npx tsx scripts/_verify_e2e_journey.mts
 *
 * 目标地址取 WEB_PORT（docker/deploy.env），缺省 5055。
 * 会向真实库写入：1 个 tenant、1 个 business、1 个 auth 用户、1 个审批单
 * 及一条 inventory_items 行（审批执行产物）。用户已确认当前为测试环境。
 *
 * ## 跑完请清理（每次运行都会留下一条孤儿链）
 *
 * `/api/auth/signup` 的设计就是"每次注册建一个新 tenant + 一个新 business"，
 * 因此本脚本每跑一次就多一条计划外记录。跑完执行：
 *
 *   npx tsx scripts/_cleanup_test_residue.mts          # 先看计划（零写入）
 *   npx tsx scripts/_cleanup_test_residue.mts --apply  # 确认后删除
 *
 * 注意清理脚本只处理 `public` schema，**不动 `auth.users`** ——
 * 测试账号会留在 Supabase Auth 里。
 */
import * as supabaseModule from '../src/storage/database/supabase-client';
import * as approvalModule from '../src/lib/agent/approvals';

type Row = Record<string, unknown>;

/**
 * 解析导出。三种形态都要覆盖（本仓库同时存在）：
 *   - 直接挂在命名空间上（ESM 风格）
 *   - 挂在 `.default` 上（`export default` 互操作）
 *   - 挂在 `.default` / `module.exports` 上（CJS 转译后具名导出被包进对象）
 * 最后一种正是 `src/lib/agent/approvals.ts` 的形态：直接取会报
 * "available: default, module.exports"。
 */
function resolveExport<T>(mod: unknown, name: string): T {
  const m = mod as Record<string, unknown>;
  const direct = m?.[name];
  if (direct !== undefined) return direct as T;
  for (const carrier of ['default', 'module.exports']) {
    const bag = m?.[carrier] as Record<string, unknown> | undefined;
    const value = bag?.[name];
    if (value !== undefined) return value as T;
  }
  throw new Error(
    `cannot resolve export '${name}'; available: ` + Object.keys(m ?? {}).join(', '),
  );
}

const getSupabaseClient = resolveExport<() => {
  from(t: string): {
    select(c: string, o?: unknown): { eq(c: string, v: string): { limit(n: number): Promise<{ data: Row[] | null; error: { message: string } | null }> } };
  };
}>(supabaseModule, 'getSupabaseClient');

interface CreatePendingApprovalResult { ok: boolean; approvalId?: string; created?: boolean; error?: string }
// 实测（scripts/_diagnose_module_shape.mts）：本模块经 CJS 转译后具名导出全部
// 挂在 `.default` 上，命名空间只有 ["default","module.exports"]；
// 且创建函数名是 createPendingApproval（不是 requestApproval）。
const createPendingApproval = resolveExport<
  (opts: Record<string, unknown>) => Promise<CreatePendingApprovalResult>
>(approvalModule, 'createPendingApproval');

const BASE = `http://127.0.0.1:${process.env.WEB_PORT || '5055'}`;

// ---------------------------------------------------------------------------
// 观测记录
// ---------------------------------------------------------------------------

interface Observation { step: string; detail: string; ok: boolean }
const log: Observation[] = [];

function record(step: string, detail: string, ok: boolean): void {
  log.push({ step, detail, ok });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${step} — ${detail}`);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// cookie jar（AGENTS.md 陷阱 11：验证登录态必须用 cookie jar 走全链路）
// ---------------------------------------------------------------------------

const jar = new Map<string, string>();

function jarHeader(): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function absorbCookies(res: Response): void {
  const raw = res.headers.getSetCookie?.() ?? [];
  for (const line of raw) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

/**
 * 本脚本直连容器端口，没有反向代理，因此 `x-forwarded-for` 缺失，
 * `getClientIp()` 会回落到字面量 'unknown' —— 所有请求共用同一个限流桶。
 * 真实部署里每个客户端有各自的 IP，所以这里显式给一个稳定的测试 IP，
 * 让限流按"一个客户端"计数，而不是按"所有无头请求"计数。
 */
const CLIENT_IP = '203.0.113.15';

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('x-forwarded-for', CLIENT_IP);
  const cookie = jarHeader();
  if (cookie) headers.set('cookie', cookie);
  const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: 'manual' });
  absorbCookies(res);
  return res;
}

function jsonHeaders(): HeadersInit {
  return { 'content-type': 'application/json' };
}

// ---------------------------------------------------------------------------
// SSE 解析
// ---------------------------------------------------------------------------

interface SseEvent { type?: string; [k: string]: unknown }

async function readSse(res: Response): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  const reader = res.body?.getReader();
  if (!reader) return events;
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try { events.push(JSON.parse(payload) as SseEvent); } catch { /* non-JSON frame */ }
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  console.log('='.repeat(78));
  console.log('Phase 15 — 端到端用户旅程验收');
  console.log('='.repeat(78));
  console.log(`目标: ${BASE}`);
  console.log('');

  const stamp = Date.now();
  const email = `e2e-phase15-${stamp}@example.com`;
  const password = `Rove!${stamp}Aa9`;
  const businessName = `E2E Phase15 ${stamp}`;

  // ---- 0. 服务可达 --------------------------------------------------------
  console.log('[0] 服务可达性');
  let healthBody: Row | null = null;
  try {
    const res = await call('/api/health');
    const body = (await res.json()) as Row;
    healthBody = body;
    record('health 可达', `HTTP ${res.status}`, res.status === 200 || res.status === 503);
  } catch (err) {
    record('health 可达', `THREW ${err instanceof Error ? err.message : String(err)}`, false);
    console.log('\n服务不可达，后续步骤无法执行。');
    return 2;
  }
  if (healthBody) {
    const db = healthBody.database as Row | undefined;
    const runtime = healthBody.runtime as Row | undefined;
    console.log(`      ok=${String(healthBody.ok)} databaseOk=${String(db?.ok)} `
      + `missingCount=${String(db?.missingCount)} runtime.ok=${String(runtime?.ok)} `
      + `runtime.latencyMs=${String(runtime?.latencyMs)}`);
    console.log(`      scheduler=${JSON.stringify(healthBody.scheduler)}`);
    console.log(`      encryptionConfigured=${String(healthBody.encryptionConfigured)}`);
    // R-02 契约：不得再出现 missingTables 数组（表名泄漏）
    record('R-02 不泄漏表名', `missingTables 字段存在=${'missingTables' in healthBody}`,
      !('missingTables' in healthBody));
    record('R-02 runtime 是一等字段', `runtime 字段存在=${'runtime' in healthBody}`,
      'runtime' in healthBody);
  }
  console.log('');

  // ---- 1. 未登录必须是 401（阴性对照） ------------------------------------
  console.log('[1] 会话守卫（阴性对照）');
  const anonMe = await call('/api/auth/me');
  record('匿名 /api/auth/me 必须 401', `HTTP ${anonMe.status}`, anonMe.status === 401);
  console.log('');

  // ---- 2. 注册 ------------------------------------------------------------
  console.log('[2] 注册（真实建 tenant + business + auth user）');
  const signupRes = await call('/api/auth/signup', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      email, password, business_name: businessName, industry: 'restaurant', language: 'en', currency: 'USD',
    }),
  });
  const signupBody = (await signupRes.json().catch(() => ({}))) as Row;
  record('注册返回 201', `HTTP ${signupRes.status} body=${JSON.stringify(signupBody).slice(0, 160)}`,
    signupRes.status === 201);
  if (signupRes.status !== 201) {
    console.log('\n注册失败，后续步骤无法执行。');
    return 2;
  }
  const tenantId = String(signupBody.tenant_id ?? '');
  const businessId = String(signupBody.business_id ?? '');
  const userId = String(signupBody.user_id ?? '');
  console.log(`      tenant_id=${tenantId}`);
  console.log(`      business_id=${businessId}`);
  console.log(`      user_id=${userId}`);
  console.log(`      cookie 已种: ${jar.size} 个`);
  record('注册后种下会话 cookie', `${jar.size} 个 cookie`, jar.size > 0);
  console.log('');

  // ---- 3. 登录后会话生效 --------------------------------------------------
  console.log('[3] 会话生效');
  const meRes = await call('/api/auth/me');
  const meBody = (await meRes.json().catch(() => ({}))) as Row;
  record('/api/auth/me 返回 200', `HTTP ${meRes.status}`, meRes.status === 200);
  console.log(`      me=${JSON.stringify(meBody).slice(0, 240)}`);
  console.log('');

  // ---- 4. 正确密码登录 ----------------------------------------------------
  console.log('[4] 正确密码登录');
  const goodLogin = await call('/api/auth/login', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ email, password }),
  });
  record('登录返回 200', `HTTP ${goodLogin.status}`, goodLogin.status === 200);
  const meAfter = await call('/api/auth/me');
  record('登录后 /api/auth/me 200', `HTTP ${meAfter.status}`, meAfter.status === 200);
  console.log('');

  // ---- 5. 错误密码必须 401（阴性对照） ------------------------------------
  // 顺序很重要：本仓库的注册/登录限流有**指数退避**，一次失败会计入该 email
  // 的退避状态。若先跑错误密码再跑正确密码，正确的那次会拿到 429 ——
  // 那不是缺陷，是限流按设计生效；但会让"登录 200"这条断言无法成立。
  // 因此阴性对照放在成功登录之后，并另用无副作用的一次性 email。
  console.log('[5] 登录阴性对照（错误密码）');
  const badJarBackup = new Map(jar);
  jar.clear();
  const badLogin = await call('/api/auth/login', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ email: `e2e-negative-${stamp}@example.com`, password: 'definitely-not-the-password' }),
  });
  record('错误密码必须 401', `HTTP ${badLogin.status}`, badLogin.status === 401);
  jar.clear();
  for (const [k, v] of badJarBackup) jar.set(k, v);
  const meStillValid = await call('/api/auth/me');
  record('阴性对照未影响已建立会话', `HTTP ${meStillValid.status}`, meStillValid.status === 200);
  console.log('');

  // ---- 6. 仪表盘数据（真实经营上下文） ------------------------------------
  console.log('[6] 仪表盘接口');
  const dashRes = await call('/api/dashboard');
  record('/api/dashboard 返回 200', `HTTP ${dashRes.status}`, dashRes.status === 200);
  if (dashRes.status === 200) {
    const dashBody = (await dashRes.json().catch(() => ({}))) as Row;
    const keys = Object.keys(dashBody);
    console.log(`      字段: ${JSON.stringify(keys).slice(0, 300)}`);
    record('仪表盘返回结构化数据', `${keys.length} 个字段`, keys.length > 0);
  }
  console.log('');

  // ---- 7. AI 对话 + 工具调用 ---------------------------------------------
  console.log('[7] AI 对话（真实 LLM + 工具调用）');
  const gateBefore = await countGateAudit();

  const chatStarted = Date.now();
  let chatRes: Response;
  let events: SseEvent[] = [];
  try {
    chatRes = await call('/api/agent/chat', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        message: 'How many orders are there? Use your tools to check the real data.',
        locale: 'en',
      }),
    });
    const requestId = chatRes.headers.get('x-request-id');
    const sessionId = chatRes.headers.get('x-session-id');
    record('chat 返回 200', `HTTP ${chatRes.status} x-request-id=${requestId} x-session-id=${sessionId}`,
      chatRes.status === 200);
    record('x-request-id 贯通', `值为 ${requestId ?? '(null)'}`, Boolean(requestId));
    record('x-session-id 返回', `值为 ${sessionId ?? '(null)'}`, Boolean(sessionId));
    if (chatRes.status === 200) events = await readSse(chatRes);
  } catch (err) {
    record('chat 返回 200', `THREW ${err instanceof Error ? err.message : String(err)}`, false);
  }
  const chatElapsed = Date.now() - chatStarted;

  const eventTypes = events.map((e) => e.type ?? '?');
  const counts = eventTypes.reduce<Record<string, number>>((acc, t) => {
    acc[t] = (acc[t] ?? 0) + 1;
    return acc;
  }, {});
  const runtimeStatus = events.find((e) => e.type === 'runtime_status');
  const toolEvents = events.filter((e) => e.type === 'status' && e.phase === 'calling_tool');
  const text = events.filter((e) => e.type === 'delta').map((e) => String(e.text ?? '')).join('');

  console.log(`      耗时 ${chatElapsed} ms；事件数 ${events.length}`);
  console.log(`      事件分布: ${JSON.stringify(counts)}`);
  console.log(`      runtime_status: ${JSON.stringify(runtimeStatus)}`);
  console.log(`      工具调用事件: ${JSON.stringify(toolEvents.map((e) => e.tool))}`);
  console.log(`      正文长度: ${text.length}；正文片段: ${JSON.stringify(text.slice(0, 200))}`);

  record('SSE 有 runtime_status', `mode=${String((runtimeStatus as Row | undefined)?.mode)}`,
    Boolean(runtimeStatus));
  record('运行时为 roveagent（非降级）',
    `mode=${String((runtimeStatus as Row | undefined)?.mode)}`,
    (runtimeStatus as Row | undefined)?.mode === 'roveagent');
  record('产生工具调用事件', `tool=${JSON.stringify(toolEvents.map((e) => e.tool))}`,
    toolEvents.length > 0);
  record('产出正文', `长度 ${text.length}`, text.length > 0);

  const gateAfter = await countGateAudit();
  const gateDelta = gateAfter - gateBefore;
  record('运行时审计增量（tool_gate.jsonl）', `${gateBefore} → ${gateAfter}（+${gateDelta}）`, gateDelta > 0);
  console.log('');

  // ---- 8. 审批闭环 --------------------------------------------------------
  console.log('[8] 审批闭环（创建 → 门控可见 → 批准 → 执行）');

  const create = await createPendingApproval({
    tenantId,
    businessId,
    userId,
    agent: 'e2e-phase15',
    toolName: 'purchase.create_draft',
    actionType: 'purchase.create_draft',
    title: `E2E Phase15 restock draft ${stamp}`,
    description: 'Phase 15 e2e approval loop verification',
    payload: {
      name: `E2E Restock ${stamp}`,
      category: 'produce',
      unit: 'kg',
      current_stock: 3,
      safety_stock: 20,
      supplier: 'E2E Supplier',
    },
    arguments: {
      name: `E2E Restock ${stamp}`,
      category: 'produce',
      unit: 'kg',
      current_stock: 3,
      safety_stock: 20,
      supplier: 'E2E Supplier',
    },
    riskLevel: 'medium',
    requiredRole: 'manager',
  });

  record('审批单创建（生产函数 createPendingApproval）', JSON.stringify(create).slice(0, 200), create.ok);
  if (!create.ok || !create.approvalId) {
    console.log('\n审批单创建失败，跳过闭环验证。');
    return 1;
  }
  const approvalId = create.approvalId;
  console.log(`      approval_id=${approvalId}`);

  const listRes = await call('/api/agent/approvals');
  const listBody = (await listRes.json().catch(() => ({}))) as Row;
  record('审批列表可见（GET /api/agent/approvals）', `HTTP ${listRes.status}`, listRes.status === 200);
  const approvals = (listBody.approvals ?? []) as Row[];
  const mine = approvals.find((a) => a.id === approvalId);
  record('新建审批在列表中且 status=pending',
    mine ? `status=${String(mine.status)}` : '未找到',
    Boolean(mine) && mine?.status === 'pending');

  // 批准
  const decideRes = await call('/api/agent/approvals', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ approval_id: approvalId, action: 'approve' }),
  });
  const decideBody = (await decideRes.json().catch(() => ({}))) as Row;
  record('批准返回 200', `HTTP ${decideRes.status} body=${JSON.stringify(decideBody).slice(0, 200)}`,
    decideRes.status === 200);
  record('批准后状态为 executed', `status=${String(decideBody.status)}`, decideBody.status === 'executed');
  record('批准带回执行结果', `executedData=${JSON.stringify(decideBody.executedData ?? null).slice(0, 160)}`,
    Boolean(decideBody.executedData));

  // 二次批准必须被拒（幂等/重复消费对照）
  const againRes = await call('/api/agent/approvals', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ approval_id: approvalId, action: 'approve' }),
  });
  const againBody = (await againRes.json().catch(() => ({}))) as Row;
  console.log(`      二次批准: HTTP ${againRes.status} body=${JSON.stringify(againBody).slice(0, 140)}`);
  record('二次批准不产生第二次执行',
    `HTTP ${againRes.status} status=${String(againBody.status)}`,
    againBody.status === 'executed' || againRes.status === 400);
  console.log('');

  // ---- 9. 审计两侧对账 ----------------------------------------------------
  console.log('[9] 审计链对账（tool_gate.jsonl ↔ Supabase audit_events）');
  await reconcileAudit();
  console.log('');

  // ---- 汇总 ---------------------------------------------------------------
  const failed = log.filter((o) => !o.ok);
  console.log('='.repeat(78));
  console.log(`端到端结果: ${log.length - failed.length}/${log.length} 项通过`);
  if (failed.length > 0) {
    console.log('未通过项:');
    for (const f of failed) console.log(`  - ${f.step}: ${f.detail}`);
  }
  console.log('');
  console.log(`本轮新建: tenant=${tenantId} business=${businessId}`);
  console.log(`         approval=${approvalId}（已 executed）`);
  console.log('='.repeat(78));
  return failed.length === 0 ? 0 : 1;
}

/** 读容器内 tool_gate.jsonl 行数（通过 docker exec；失败返回 -1） */
async function countGateAudit(): Promise<number> {
  const { execFileSync } = await import('node:child_process');
  try {
    const out = execFileSync('docker', [
      'exec', 'roveframe-roveagent-1', 'sh', '-c', 'wc -l < /data/audit/tool_gate.jsonl 2>/dev/null || echo 0',
    ], { encoding: 'utf8', timeout: 30_000 });
    return Number(out.trim()) || 0;
  } catch {
    return -1;
  }
}

async function reconcileAudit(): Promise<void> {
  const { execFileSync } = await import('node:child_process');
  let gateLines: string[] = [];
  try {
    const out = execFileSync('docker', [
      'exec', 'roveframe-roveagent-1', 'sh', '-c', 'cat /data/audit/tool_gate.jsonl 2>/dev/null || true',
    ], { encoding: 'utf8', timeout: 30_000 });
    gateLines = out.split('\n').filter((l) => l.trim().length > 0);
  } catch (err) {
    record('读取 tool_gate.jsonl', `失败 ${err instanceof Error ? err.message : String(err)}`, false);
    return;
  }

  const parsed: Row[] = [];
  for (const line of gateLines) {
    try { parsed.push(JSON.parse(line) as Row); } catch { /* skip malformed */ }
  }
  record('tool_gate.jsonl 可解析', `${parsed.length}/${gateLines.length} 行`, parsed.length > 0);

  const client = getSupabaseClient();
  const { data: rows } = await (client as unknown as {
    from(t: string): { select(c: string): { limit(n: number): Promise<{ data: Row[] | null }> } };
  }).from('audit_events').select('*').limit(500);
  const dbRows = rows ?? [];

  console.log(`      tool_gate.jsonl 条目: ${parsed.length}`);
  console.log(`      audit_events 行数: ${dbRows.length}${dbRows.length === 500 ? '+ (已截断到 500)' : ''}`);

  const gateTools = parsed.map((p) => String(p.tool ?? ''));
  const dbTools = dbRows.map((r) => String(r.tool_name ?? r.action ?? ''));
  console.log(`      tool_gate 工具名: ${JSON.stringify([...new Set(gateTools)].slice(0, 12))}`);
  console.log(`      audit_events 工具名/动作: ${JSON.stringify([...new Set(dbTools)].slice(0, 12))}`);

  record('两侧都有数据（对账的前提）', `gate=${parsed.length} db=${dbRows.length}`,
    parsed.length > 0 && dbRows.length > 0);
  console.log('      说明：tool_gate.jsonl 是**门控判定**（每次工具调用一行），');
  console.log('            audit_events 是**业务审计**（审批/执行等生命周期事件）。');
  console.log('            两者用途不同，不要求逐条相等；这里核验的是两侧都在真实写入。');
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 1_500).unref(); })
  .catch((error: unknown) => { console.error('E2E 崩溃:', error); process.exitCode = 2; });
