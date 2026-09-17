/**
 * Phase 15 — 数据漂移取证（只读）。
 *
 * Phase 14 记录了 `tenants` 3 行 / `businesses` 2 行，与"唯一锚点"的文档约定
 * 不符，但只做了计数，没有取证。本脚本回答三个问题：
 *
 *   1. 多出来的行**具体是什么**（不是数量，是内容）；
 *   2. 它们**是不是孤儿**（所属 tenant 是否还存在、是否挂着业务数据）；
 *   3. 它们**是否被代码引用**（users / orders / customers 等按 tenant_id 归属）。
 *
 * ## 只读
 *
 * 仅 `select`。无 insert / update / delete / ddl。
 * 不打印凭据；只打印主机名、行内容与计数。
 */
import * as supabaseModule from '../src/storage/database/supabase-client';

type Row = Record<string, unknown>;

type CountResult = { count: number | null; data: unknown; error: { message: string } | null };
type LimitResult = { data: Row[] | null; error: { message: string } | null };

/** `select(col).eq(col, v).limit(n)` 的链式形态。 */
type FilteredQuery = {
  eq(column: string, value: string): { limit(n: number): Promise<LimitResult> };
};

type SupabaseLike = {
  from(table: string): {
    // 必须写成**重载**而不是返回类型的联合。写成联合时 TypeScript 取第一个
    // 匹配的签名，于是 `select(col)` 被解析成返回 Promise，`.eq()` 报
    // "Property 'eq' does not exist"（Next 构建期全项目 tsc 会因此失败）。
    select(columns: string, opts: { count: 'exact'; head: true }): Promise<CountResult>;
    select(columns: string): FilteredQuery & { limit(n: number): Promise<LimitResult> };
  };
};

function resolveExport<T>(mod: unknown, name: string): T {
  const direct = (mod as Record<string, unknown>)?.[name];
  if (direct !== undefined) return direct as T;
  const viaDefault = (mod as { default?: Record<string, unknown> })?.default?.[name];
  if (viaDefault !== undefined) return viaDefault as T;
  throw new Error(`cannot resolve export '${name}'`);
}

const getSupabaseClient = resolveExport<() => SupabaseLike>(supabaseModule, 'getSupabaseClient');

/** 文档约定的唯一锚点 */
const DEFAULT_TENANT = '00000000-0000-0000-0000-000000000000';
const DEFAULT_BUSINESS = '00000000-0000-0000-0000-000000000001';

/** 归属到 tenant / business 的业务表，用来判断某行是不是孤儿 */
const TENANT_SCOPED = ['users', 'businesses', 'settings', 'chat_sessions', 'audit_events'] as const;
const BUSINESS_SCOPED = [
  'orders', 'customers', 'products', 'reservations', 'reviews', 'emails',
  'documents', 'doc_chunks', 'store_qr_codes', 'inventory_items', 'suppliers',
  'purchase_orders', 'marketing_campaigns', 'agent_tasks', 'agent_approvals',
] as const;

function short(v: unknown): string {
  const s = String(v ?? '');
  return s.length > 20 ? `${s.slice(0, 18)}…` : s;
}

async function countWhere(
  client: SupabaseLike, table: string, column: string, value: string,
): Promise<number | string> {
  const { count, error } = await client
    .from(table).select('*', { count: 'exact', head: true });
  if (error) return `ERR ${error.message.slice(0, 40)}`;
  void count;
  // 上面的 head 计数不支持 filter，改用 eq + limit 统计实际返回行数。
  const { data, error: e2 } = await client
    .from(table).select(column).eq(column, value).limit(500);
  if (e2) return `ERR ${e2.message.slice(0, 40)}`;
  return (data ?? []).length;
}

async function main(): Promise<number> {
  const url = process.env.COZE_SUPABASE_URL ?? '';
  let host = '(unknown)';
  try { host = new URL(url).host; } catch { /* keep default */ }

  console.log('='.repeat(78));
  console.log('Phase 15 — 数据漂移取证（只读）');
  console.log('='.repeat(78));
  console.log(`目标主机: ${host}`);
  console.log('');

  const client = getSupabaseClient();

  // ---- 1. tenants 全部行 -------------------------------------------------
  const { data: tenants, error: te } = await client.from('tenants')
    .select('id,name,created_at').limit(50);
  if (te) { console.log(`tenants 读取失败: ${te.message}`); return 2; }
  console.log(`[1] tenants 全部 ${tenants?.length ?? 0} 行:`);
  for (const t of tenants ?? []) {
    const marker = String(t.id) === DEFAULT_TENANT ? '  <-- 文档锚点' : '  <-- 计划外';
    console.log(`    ${short(t.id)}  name=${JSON.stringify(t.name)}  created=${String(t.created_at ?? '-')}${marker}`);
  }

  // ---- 2. businesses 全部行 ----------------------------------------------
  const { data: businesses, error: be } = await client.from('businesses')
    .select('id,tenant_id,name,created_at').limit(50);
  if (be) { console.log(`businesses 读取失败: ${be.message}`); return 2; }
  console.log('');
  console.log(`[2] businesses 全部 ${businesses?.length ?? 0} 行:`);
  for (const b of businesses ?? []) {
    const marker = String(b.id) === DEFAULT_BUSINESS ? '  <-- 文档锚点' : '  <-- 计划外';
    console.log(`    ${short(b.id)}  tenant=${short(b.tenant_id)}  name=${JSON.stringify(b.name)}  created=${String(b.created_at ?? '-')}${marker}`);
  }

  // ---- 3. 计划外的 tenant 是否孤儿 ---------------------------------------
  const extraTenants = (tenants ?? []).filter((t) => String(t.id) !== DEFAULT_TENANT);
  console.log('');
  console.log(`[3] 计划外 tenant 的引用计数（${extraTenants.length} 个）:`);
  for (const t of extraTenants) {
    const id = String(t.id);
    console.log(`    tenant ${short(id)} name=${JSON.stringify(t.name)}`);
    for (const table of TENANT_SCOPED) {
      const n = await countWhere(client, table, 'tenant_id', id);
      console.log(`        ${table.padEnd(18)} ${n}`);
    }
  }

  // ---- 4. 计划外的 business 是否孤儿 -------------------------------------
  const extraBiz = (businesses ?? []).filter((b) => String(b.id) !== DEFAULT_BUSINESS);
  console.log('');
  console.log(`[4] 计划外 business 的引用计数（${extraBiz.length} 个）:`);
  for (const b of extraBiz) {
    const id = String(b.id);
    console.log(`    business ${short(id)} name=${JSON.stringify(b.name)} tenant=${short(b.tenant_id)}`);
    for (const table of BUSINESS_SCOPED) {
      const n = await countWhere(client, table, 'business_id', id);
      const flag = typeof n === 'number' && n > 0 ? '  <-- 有数据' : '';
      console.log(`        ${table.padEnd(20)} ${n}${flag}`);
    }
  }

  console.log('');
  console.log('='.repeat(78));
  console.log('取证结束。未做任何写入。');
  console.log('='.repeat(78));
  return 0;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 2_000).unref(); })
  .catch((error: unknown) => { console.error('取证崩溃:', error); process.exitCode = 2; });
