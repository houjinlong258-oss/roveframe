/**
 * Phase 15 — 修正 boot-check / scheduler 的存在性探针（只读，先验证后修改）。
 *
 * ## 背景
 *
 * `_prove_bootcheck_failopen.mts` 已证明：生产函数 `runBootChecks()` 用的
 * `select('*', { count:'exact', head:true })` 形态对**不存在的表**也返回 204、
 * `error === null`，因此"缺缺失 0 项"恒成立，不具检测能力。
 * `src/lib/scheduler.ts:46` 的 `cron_state` 就绪判定是同一形态。
 *
 * ## 修改前必须先验证的事
 *
 * 把探针从 `select('*', head:true)` 改成 `select('<col>')` 会**收紧**检测。
 * 收紧有它自己的风险：若某张表没有 `<col>` 列，会报 42703（列不存在），
 * 被误判成"表缺失"—— 那是把 fail-open 变成 fail-closed 的**误报**。
 *
 * 所以本脚本先对每个候选列实测，确认：
 *   1. 该列在目标表上确实存在（否则换列）；
 *   2. 用该列的探针能检出**不存在的表**（阴性对照）。
 *
 * 只有两条都过了，`<col>` 才能写进生产代码。
 */
import * as supabaseModule from '../src/storage/database/supabase-client';

const getSupabaseClient = (supabaseModule as unknown as {
  getSupabaseClient?: () => unknown;
}).getSupabaseClient
  ?? (supabaseModule as unknown as { default?: { getSupabaseClient: () => unknown } })
    .default?.getSupabaseClient;
if (!getSupabaseClient) throw new Error('getSupabaseClient not resolvable');

/** `src/lib/boot-check.ts` 的 REQUIRED_TABLES，原样照搬 */
const REQUIRED_TABLES = [
  'cron_state', 'staff', 'business_memories', 'agent_actions', 'agent_approvals',
  'payments', 'payment_events', 'ai_usage_ledger', 'platform_admins',
  'tenant_subscriptions', 'platform_admin_audit_logs',
] as const;

type Res = { status?: number; error?: { message?: string; code?: string } | null; count?: number | null };

function mkProbe(client: unknown) {
  return (table: string, col: string): Promise<Res> =>
    (client as { from(t: string): { select(c: string, o?: unknown): Promise<Res> } })
      .from(table).select(col, { count: 'exact' });
}

async function main(): Promise<number> {
  const client = getSupabaseClient!();
  const probe = mkProbe(client);

  console.log('='.repeat(78));
  console.log('Phase 15 — 存在性探针列选型验证');
  console.log('='.repeat(78));
  console.log('');

  // ---- 1. 阴性对照：收紧后的形态必须能败 ---------------------------------
  console.log('[1] 阴性对照（收紧后的形态，必须 404）:');
  let controlOk = true;
  for (const t of ['zzz_definitely_not_a_table_9f3a', 'public.also_not_real_7b1c']) {
    const r = await probe(t, 'id');
    const detected = r.status !== 200;
    if (!detected) controlOk = false;
    console.log(`    ${t.padEnd(34)} status=${String(r.status).padEnd(5)} ${detected ? '✓ 检出缺失' : '✗ 未检出'}`);
  }
  console.log(`    对照: ${controlOk ? '通过' : '失败'}`);
  console.log('');

  // ---- 2. 逐表确认探针列存在 ---------------------------------------------
  console.log('[2] 逐表选型（优先 key，其次 id，最后 *）:');
  console.log(`${'table'.padEnd(30)} ${'key'.padEnd(22)} ${'id'.padEnd(22)} 选定`);
  console.log('-'.repeat(78));
  const chosen: Record<string, string> = {};
  let badChoice = false;

  for (const t of REQUIRED_TABLES) {
    const results: Record<string, string> = {};
    for (const col of ['key', 'id']) {
      const r = await probe(t, col);
      results[col] = r.status === 200
        ? '存在'
        : `status=${r.status} ${(r.error?.code ?? '')}`;
    }
    // key 优先（复合主键表如 cron_state 只有 key）；否则 id；都没有才退回 *
    let pick = '*';
    if (results.key === '存在') pick = 'key';
    else if (results.id === '存在') pick = 'id';
    if (pick === '*') badChoice = true;
    chosen[t] = pick;
    console.log(`${t.padEnd(30)} ${results.key.padEnd(22)} ${results.id.padEnd(22)} ${pick}`);
  }
  console.log('');

  // ---- 3. 用选定的列复测一遍（确认全部 200） ------------------------------
  console.log('[3] 用选定列复测:');
  let allOk = true;
  for (const t of REQUIRED_TABLES) {
    const r = await probe(t, chosen[t]);
    const ok = r.status === 200;
    if (!ok) allOk = false;
    console.log(`    ${t.padEnd(30)} ${String(chosen[t]).padEnd(8)} status=${r.status} ${ok ? 'OK' : 'FAIL ' + (r.error?.message ?? '')}`);
  }
  console.log('');

  console.log('='.repeat(78));
  console.log('选型表（可写入生产代码）:');
  for (const t of REQUIRED_TABLES) console.log(`    ${t}: '${chosen[t]}'`);
  console.log('');
  console.log(`可安全收紧: ${controlOk && allOk && !badChoice ? '是' : '否 —— 不要改生产代码'}`);
  console.log('='.repeat(78));
  return 0;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 1_500).unref(); })
  .catch((error: unknown) => { console.error('验证崩溃:', error); process.exitCode = 2; });
