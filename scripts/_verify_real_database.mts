/**
 * Phase 14 —— 真实数据库只读核验。
 *
 * 用仓库**已有的**凭据（scripts/deploy.env，已被 gitignore）直连真实 Supabase，
 * 回答三个问题：
 *
 *   1. schema.ts 声明的表，真实库里存在哪些、缺哪些；
 *   2. 关键表的行数（种子数据是否真的灌进去了）；
 *   3. 本仓库代码能不能真的读写它（而不是只连上）。
 *
 * ## 这是只读脚本
 *
 * 只做 `select`，没有任何 insert / update / delete / ddl。
 * 不打印任何凭据值，只打印主机名。
 */
// supabase-client.ts 是 CJS 互操作风格，ESM 具名导入解析不到。
// 用命名空间导入后在运行时取，避免依赖 loader 的具名导出探测。
import * as supabaseModule from '../src/storage/database/supabase-client';

type SupabaseLike = {
  from(table: string): {
    select(columns: string, opts?: { count?: string; head?: boolean }): Promise<{
      count: number | null;
      data: unknown;
      error: { message: string } | null;
    }> & { limit(n: number): Promise<{ data: unknown; error: { message: string } | null }> };
  };
};

// CJS 互操作下导出可能直接挂在命名空间上，也可能被包进 .default。
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

const getSupabaseClient = resolveExport<() => SupabaseLike>(
  supabaseModule, 'getSupabaseClient',
);

/** schema.ts 里声明的表（Phase 11 审计实测 51 张） */
const EXPECTED_TABLES = [
  'tenants', 'businesses', 'users', 'settings', 'model_configs',
  'products', 'orders', 'customers', 'reservations', 'reviews',
  'email_accounts', 'emails', 'email_send_tasks', 'marketing_campaigns',
  'documents', 'doc_chunks', 'chat_sessions', 'chat_messages',
  'agent_approvals', 'agent_tasks', 'audit_events', 'health_check',
  'integration_configs', 'integration_events', 'store_qr_codes',
  'cron_state', 'ai_usage_ledger', 'business_memories', 'suppliers',
  'purchase_orders', 'inventory_items', 'staff', 'notifications',
] as const;

/** 行数有意义的关键表（种子数据核验） */
const COUNT_TABLES = [
  'products', 'customers', 'orders', 'doc_chunks', 'documents',
  'tenants', 'businesses', 'users', 'audit_events', 'agent_approvals',
  'chat_sessions', 'model_configs',
] as const;

async function countOf(client: SupabaseLike, table: string) {
  // head:true + count:'exact' 只取计数，不拉行数据。
  const { count, error } = await client
    .from(table)
    .select('*', { count: 'exact', head: true });
  if (error) return { ok: false as const, error: error.message };
  return { ok: true as const, count: count ?? 0 };
}

async function main(): Promise<number> {
  const url = process.env.COZE_SUPABASE_URL ?? '';
  let host = '(unknown)';
  try { host = new URL(url).host; } catch { /* keep default */ }

  console.log('='.repeat(74));
  console.log('Phase 14 — 真实数据库只读核验');
  console.log('='.repeat(74));
  console.log(`目标主机: ${host}`);
  console.log(`service_role 已配置: ${Boolean(process.env.COZE_SUPABASE_SERVICE_ROLE_KEY)}`);
  console.log('');

  const client = getSupabaseClient();

  // ---- 1. 表存在性 ------------------------------------------------------
  const missing: string[] = [];
  const present: string[] = [];
  for (const table of EXPECTED_TABLES) {
    const { error } = await client.from(table).select('*', { count: 'exact', head: true });
    if (error) missing.push(`${table} (${error.message.slice(0, 60)})`);
    else present.push(table);
  }
  console.log(`[1] 表存在性: ${present.length}/${EXPECTED_TABLES.length} 存在`);
  if (missing.length) {
    console.log(`    缺失 ${missing.length} 张:`);
    for (const m of missing) console.log(`      - ${m}`);
  }

  // ---- 2. 行数 ----------------------------------------------------------
  console.log('');
  console.log('[2] 关键表行数:');
  const counts: Record<string, number> = {};
  for (const table of COUNT_TABLES) {
    const r = await countOf(client, table);
    if (r.ok) {
      counts[table] = r.count;
      console.log(`    ${table.padEnd(20)} ${String(r.count).padStart(8)}`);
    } else {
      console.log(`    ${table.padEnd(20)}        ERR  ${r.error.slice(0, 50)}`);
    }
  }

  // ---- 3. 真实可读（不只是连上）-----------------------------------------
  console.log('');
  const seeded = ['products', 'customers', 'orders'].filter((t) => (counts[t] ?? 0) > 0);
  console.log(`[3] 种子数据: ${seeded.length}/3 张核心业务表非空 ${seeded.length ? '✓' : '✗'}`);
  if (seeded.length < 3) {
    console.log('    预期：由迁移 + 种子脚本灌入演示数据（川菜馆场景）');
  }

  // ---- 4. 多租户归属锚点 -------------------------------------------------
  console.log('');
  const { data: businesses } = await client
    .from('businesses').select('id,name').limit(5);
  console.log('[4] businesses 前若干行:');
  for (const b of businesses ?? []) {
    console.log(`    ${String(b.id).slice(0, 12)}…  ${b.name}`);
  }

  console.log('');
  console.log('='.repeat(74));
  console.log(`结果: 表 ${present.length}/${EXPECTED_TABLES.length} 存在，`
    + `核心业务表 ${seeded.length}/3 有数据。未做任何写入。`);
  console.log('='.repeat(74));
  return 0;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 2_000).unref(); })
  .catch((error: unknown) => {
    console.error('核验崩溃:', error);
    process.exitCode = 2;
  });
