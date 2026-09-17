/**
 * Phase 15 — 修正后的表存在性探针（只读）。
 *
 * ## 为什么需要这个脚本
 *
 * `scripts/_verify_real_database.mts` 的探针形态是：
 *
 *     const { error } = await client.from(t).select('*', { count:'exact', head:true })
 *
 * 对本仓库的 client 实例，该形态**永远取不到 error**：它把一个"可等待构造器"
 * 对象的顶层 `error` 属性解构了出来，而 `error` 只存在于 await 的**结果值**上。
 * 于是 `if (error)` 恒为假 → 每张表都报"存在"。
 *
 * 证据：`_verify_table_probe_control.mts` 对两个**不可能存在**的表名
 * （`zzz_definitely_not_a_table_9f3a`、`public.also_not_real_7b1c`）同样报 `OK`。
 * 一个"永远通过"的探针，其"33/33 存在"的结论不成立。
 *
 * ## 做法
 *
 * 改用**显式两段式**：先拿到构造器，再 await 求值，然后同时检查返回值里的
 * `error` **以及**构造器本身是否已经带 `error`（两种形态都覆盖，不漏判）。
 * 阴性对照放在最前面：不能败的探针无权宣布"通过"。
 */
import * as supabaseModule from '../src/storage/database/supabase-client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type ProbeOutcome = { ok: boolean; detail: string };

const getSupabaseClient = (supabaseModule as unknown as {
  getSupabaseClient?: (token?: string) => unknown;
}).getSupabaseClient
  ?? (supabaseModule as unknown as { default?: { getSupabaseClient: (token?: string) => unknown } })
    .default?.getSupabaseClient;
if (!getSupabaseClient) throw new Error('getSupabaseClient not resolvable');

/**
 * 探测一张表是否存在。
 *
 * 两个形态都查：
 *   - 构造器自身带 `error`（部分 supabase-js 版本会同步置位）；
 *   - await 结果带 `error`（正常路径）。
 * 任一非空即视为失败。这样既不漏判，也不依赖单一 SDK 形态。
 */
async function probe(client: unknown, table: string): Promise<ProbeOutcome> {
  try {
    const from = (client as { from(t: string): unknown }).from(table);
    const builder = (from as { select(c: string, o?: unknown): unknown })
      .select('*', { count: 'exact', head: true });

    // 同步属性：构造器上可能已经挂了 error
    const syncError = (builder as { error?: { message?: string } } | null)?.error;
    if (syncError) return { ok: false, detail: `builder.error: ${syncError.message ?? '(no message)'}` };

    // 异步求值
    const result = await (builder as Promise<unknown>);
    if (result === null || result === undefined) {
      return { ok: false, detail: `await 得到 ${String(result)}（既非行也非错误）` };
    }
    const err = (result as { error?: { message?: string; code?: string } }).error;
    if (err) {
      return { ok: false, detail: `result.error: ${err.message ?? JSON.stringify(err)}` };
    }
    // 没有 error 还必须确认拿到了预期形状，否则"没有 error"可能只是形状不对
    const hasShape = Object.prototype.hasOwnProperty.call(result as object, 'count')
      || Object.prototype.hasOwnProperty.call(result as object, 'data')
      || Object.prototype.hasOwnProperty.call(result as object, 'status');
    if (!hasShape) {
      return {
        ok: false,
        detail: `结果无 error 但也无 count/data/status —— 形状不符: ${JSON.stringify(result).slice(0, 120)}`,
      };
    }
    return { ok: true, detail: 'OK' };
  } catch (err) {
    return { ok: false, detail: `THREW ${err instanceof Error ? err.message : String(err)}` };
  }
}

function schemaTableNames(): Set<string> {
  const file = join(process.cwd(), 'src', 'storage', 'database', 'shared', 'schema.ts');
  const txt = readFileSync(file, 'utf8');
  const re = /pgTable\(\s*(?:"([a-z_]+)"|'([a-z_]+)'|`([a-z_]+)`)/g;
  const out = new Set<string>();
  for (const m of txt.matchAll(re)) out.add(m[1] || m[2] || m[3]);
  return out;
}

const EXPECTED = [
  'tenants', 'businesses', 'users', 'settings', 'model_configs',
  'products', 'orders', 'customers', 'reservations', 'reviews',
  'email_accounts', 'emails', 'email_send_tasks', 'marketing_campaigns',
  'documents', 'doc_chunks', 'chat_sessions', 'chat_messages',
  'agent_approvals', 'agent_tasks', 'audit_events', 'health_check',
  'integration_configs', 'integration_events', 'store_qr_codes',
  'cron_state', 'ai_usage_ledger', 'business_memories', 'suppliers',
  'purchase_orders', 'inventory_items', 'staff', 'notifications',
];

async function main(): Promise<number> {
  const client = getSupabaseClient!();
  const inSchema = schemaTableNames();

  console.log('='.repeat(78));
  console.log('Phase 15 — 修正后的表存在性探针');
  console.log('='.repeat(78));
  console.log(`schema.ts 声明 ${inSchema.size} 张表`);
  console.log('');

  // ---- 阴性对照 ---------------------------------------------------------
  console.log('[1] 阴性对照 —— 必须失败:');
  let controlOk = true;
  for (const s of ['zzz_definitely_not_a_table_9f3a', 'public.also_not_real_7b1c']) {
    const r = await probe(client, s);
    if (r.ok) controlOk = false;
    console.log(`    ${s.padEnd(34)} ${r.ok ? 'OK  <-- 对照失败' : 'FAIL ✓'}  ${r.detail}`);
  }
  // 阳性对照：一张确定存在的表必须 OK
  const pos = await probe(client, 'tenants');
  console.log(`    ${'tenants'.padEnd(34)} ${pos.ok ? 'OK ✓' : 'FAIL  <-- 阳性对照失败'}  ${pos.detail}`);
  if (!pos.ok) controlOk = false;
  console.log(`    对照结论: ${controlOk ? '探针可败且可过，结论有效' : '探针不可信，以下结果作废'}`);
  console.log('');

  // ---- 逐名实测 ---------------------------------------------------------
  console.log('[2] EXPECTED_TABLES 逐名实测:');
  const missing: string[] = [];
  const present: string[] = [];
  for (const t of EXPECTED) {
    const r = await probe(client, t);
    const tag = inSchema.has(t) ? 'schema✓' : 'schema✗';
    if (r.ok) present.push(t);
    else missing.push(`${t} (${tag}) — ${r.detail}`);
    console.log(`    ${t.padEnd(22)} ${tag}  ${r.ok ? '存在' : '缺失'}${r.ok ? '' : '   ' + r.detail}`);
  }
  console.log('');
  console.log(`    结果: ${present.length}/${EXPECTED.length} 存在`);
  if (missing.length > 0) {
    console.log(`    缺失 ${missing.length} 张:`);
    for (const m of missing) console.log(`      - ${m}`);
  }
  console.log('');

  // ---- schema.ts 定义但未纳入 EXPECTED ----------------------------------
  const notProbed = [...inSchema].filter((t) => !EXPECTED.includes(t)).sort();
  console.log(`[3] schema.ts 有定义、EXPECTED 未覆盖 (${notProbed.length}):`);
  const missingUncovered: string[] = [];
  for (const t of notProbed) {
    const r = await probe(client, t);
    if (!r.ok) missingUncovered.push(`${t} — ${r.detail}`);
    console.log(`    ${t.padEnd(30)} ${r.ok ? '存在' : '缺失   ' + r.detail}`);
  }
  console.log('');
  console.log(`    ${notProbed.length - missingUncovered.length}/${notProbed.length} 存在`);
  console.log('');

  const realMissing = missing.length + missingUncovered.length;
  console.log('='.repeat(78));
  console.log(`真实结果: schema.ts 的 ${inSchema.size} 张表中，`
    + `${inSchema.size - realMissing} 张存在于真实库，${realMissing} 张缺失。`);
  console.log(`（对照：Phase 14 用旧探针报"33/33 存在"）`);
  console.log('='.repeat(78));
  return 0;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 1_500).unref(); })
  .catch((error: unknown) => { console.error('探针崩溃:', error); process.exitCode = 2; });
