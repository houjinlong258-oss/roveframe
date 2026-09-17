/**
 * Phase 15 — 证明 boot-check 的 fail-open（只读）。
 *
 * ## 为什么这不是"测试脚本的问题"
 *
 * `src/lib/boot-check.ts`（生产启动自检，Phase 14 的 A-4 就是它的输出）用的是：
 *
 *     const { error } = await client.from(table).select('*', { count:'exact', head:true });
 *
 * `scripts/_verify_probe_validity.mts` 已证明该形态对**不存在的表**返回 204 且
 * `error === null`，因此 `Boolean(error)` 恒为 false —— 每一张表都会被判为"存在"。
 *
 * 本脚本直接**调用生产函数** `runBootChecks()`，再把同一批表名喂给一个确定
 * 不存在的前缀版本，看它是否同样报"不缺失"。如果两者无法区分，则生产自检
 * 不具备检测能力，Phase 14 的 `✓ [boot-check] 数据库 schema 完整` 不构成证据。
 *
 * 同样形态还出现在：
 *   - `src/lib/scheduler.ts:46`（cron_state 就绪判定，fail-open 会让
 *     `schedulerHealth().degraded` 恒为 false）
 *   - `src/lib/business-context.ts:80,86,89`
 *   - `src/lib/scheduler.ts` 之外见 `scripts/_verify_real_database.mts`
 *
 * ## 只读
 *
 * 仅 `select`。无写操作。
 */
// boot-check.ts / supabase-client.ts 都是 CJS 互操作风格，ESM 具名导入解析不到，
// 用命名空间导入后在运行时取（与 _verify_real_database.mts 同一处理）。
import * as bootCheckModule from '../src/lib/boot-check';
import * as supabaseModule from '../src/storage/database/supabase-client';

function resolveExport<T>(mod: unknown, name: string): T {
  const direct = (mod as Record<string, unknown>)?.[name];
  if (direct !== undefined) return direct as T;
  const viaDefault = (mod as { default?: Record<string, unknown> })?.default?.[name];
  if (viaDefault !== undefined) return viaDefault as T;
  throw new Error(
    `cannot resolve export '${name}'; available: `
    + Object.keys((mod as object) ?? {}).join(', '),
  );
}

interface BootCheckResult { table: string; missing: boolean; message: string }
const runBootChecks = resolveExport<() => Promise<BootCheckResult[]>>(bootCheckModule, 'runBootChecks');
const getSupabaseClient = resolveExport<() => unknown>(supabaseModule, 'getSupabaseClient');

/** 与生产代码 `src/lib/boot-check.ts:29` 逐字相同的探针形态 */
async function bootShapeProbe(client: unknown, table: string): Promise<{ missing: boolean; error: string }> {
  const { error } = await (client as {
    from(t: string): { select(c: string, o?: unknown): Promise<{ error?: { message?: string } | null }> };
  }).from(table).select('*', { count: 'exact', head: true });
  return { missing: Boolean(error), error: error?.message ?? '' };
}

/** 有效探针：列投影、非 head —— 已被对照实验证明能区分存在性 */
async function validProbe(client: unknown, table: string): Promise<{ status?: number; exists: boolean; detail: string }> {
  const r = await (client as {
    from(t: string): { select(c: string, o?: unknown): Promise<{ status?: number; error?: { message?: string; code?: string } | null }> };
  }).from(table).select('key', { count: 'exact' });
  return { status: r.status, exists: r.status === 200, detail: r.error?.message ?? '' };
}

async function main(): Promise<number> {
  const client = getSupabaseClient!();

  console.log('='.repeat(78));
  console.log('Phase 15 — boot-check fail-open 证明');
  console.log('='.repeat(78));
  console.log('');

  // ---- 1. 直接调用生产函数 ------------------------------------------------
  console.log('[1] 生产函数 runBootChecks() 的真实输出:');
  const results = await runBootChecks();
  const missing = results.filter((r) => r.missing);
  console.log(`    检查 ${results.length} 项，报缺失 ${missing.length} 项`);
  for (const r of results) {
    if (r.missing) console.log(`      缺失: ${r.table} — ${r.message.slice(0, 60)}`);
  }
  console.log('');

  // ---- 2. 阴性对照：把不存在的表名喂给同一形态 ----------------------------
  console.log('[2] 阴性对照（同一形态 + 绝不存在的表名）:');
  let controlBroken = false;
  for (const t of ['zzz_definitely_not_a_table_9f3a', 'public.also_not_real_7b1c']) {
    const r = await bootShapeProbe(client, t);
    if (!r.missing) controlBroken = true;
    console.log(`    ${t.padEnd(34)} missing=${r.missing}  ${r.missing ? '✓ 检出' : '✗ 未检出（fail-open）'}`);
  }
  console.log(`    结论: ${controlBroken ? '生产形态无法检出缺失表 → 自检不具检测能力' : '生产形态可检出'}`);
  console.log('');

  // ---- 3. 同一批表用有效探针复测 ------------------------------------------
  console.log('[3] 用（已证明有效的）列投影探针复测 REQUIRED_TABLES:');
  const required = [
    'cron_state', 'staff', 'business_memories', 'agent_actions', 'agent_approvals',
    'payments', 'payment_events', 'ai_usage_ledger', 'platform_admins',
    'tenant_subscriptions', 'platform_admin_audit_logs',
  ];
  let invalidProbeFound = false;
  for (const t of required) {
    const col = t === 'cron_state' ? 'key' : 'id';
    let r = await validProbe(client, t);
    if (!r.exists && /column .* does not exist/.test(r.detail)) {
      // 该表没有这一列（如复合主键表），换 * 复测
      const alt = await (client as {
        from(x: string): { select(c: string, o?: unknown): Promise<{ status?: number; error?: { message?: string } | null }> };
      }).from(t).select('*', { count: 'exact' });
      r = { status: alt.status, exists: alt.status === 200, detail: alt.error?.message ?? `${col} 列不存在，改用 *` };
      if (!r.exists) invalidProbeFound = true;
    } else if (!r.exists) invalidProbeFound = true;
    console.log(`    ${t.padEnd(30)} status=${String(r.status).padEnd(5)} ${r.exists ? '存在' : '缺失  ' + r.detail.slice(0, 40)}`);
  }
  console.log('');

  // ---- 4. 结论 -----------------------------------------------------------
  const canDetect = !controlBroken;
  console.log('='.repeat(78));
  console.log('判读:');
  console.log(`  a) 生产 boot-check 形态能否检出缺失表: ${canDetect ? '能' : '不能（fail-open）'}`);
  console.log(`  b) 11 张 REQUIRED_TABLES 用有效探针复测: ${invalidProbeFound ? '出现缺失' : '全部存在'}`);
  console.log(canDetect
    ? '  → Phase 14 的 "✓ schema 完整" 是一次真实检查。'
    : '  → Phase 14 的 "✓ schema 完整" 不能区分"表在"与"表不在"，不构成证据。');
  console.log('='.repeat(78));
  return 0;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 1_500).unref(); })
  .catch((error: unknown) => { console.error('证明崩溃:', error); process.exitCode = 2; });
