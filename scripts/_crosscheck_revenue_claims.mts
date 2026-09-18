/**
 * Phase 15 — 复核子代理提出的最关键三条（只读，直查真实库 + 源码）。
 *
 * 这三条如果成立，直接决定"这门生意能不能收钱"和"新客户第一天看到什么"，
 * 因此不能只凭读代码采信：
 *
 *   1. `subscription_plans` 是否真的**从未被灌数据** ⇒ 平台无法给商家定套餐。
 *   2. `dashboard` 是否真的**硬编码了增长百分比** ⇒ 新客户在零数据账户上
 *      看到编造的增长数字（这是诚信问题，不只是 bug）。
 *   3. signup 是否真的**不建 settings 行** ⇒ 新商家的店铺名/货币为空。
 */
import * as supabaseModule from '../src/storage/database/supabase-client';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

type Res = { data: unknown[] | null; error: { message: string } | null };

const getSupabaseClient = (supabaseModule as unknown as { getSupabaseClient?: () => unknown }).getSupabaseClient
  ?? (supabaseModule as unknown as { default?: { getSupabaseClient?: () => unknown } }).default?.getSupabaseClient;
if (!getSupabaseClient) throw new Error('getSupabaseClient not resolvable');

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

async function main(): Promise<number> {
  const client = getSupabaseClient!() as unknown as {
    from(t: string): { select(c: string, o?: unknown): { limit(n: number): Promise<Res> } };
  };
  const count = async (table: string): Promise<string> => {
    const { data, error } = await client.from(table).select('id', { count: 'exact', head: true } as unknown as string).limit(1);
    if (error) return `ERR ${error.message.slice(0, 50)}`;
    return String((data ?? []).length);
  };

  console.log('='.repeat(86));
  console.log('Phase 15 — 关键结论复核');
  console.log('='.repeat(86));

  // ---- 1. subscription_plans / tenant_subscriptions ------------------------
  console.log('');
  console.log('[1] 订阅相关表的真实数据');
  for (const t of ['subscription_plans', 'tenant_subscriptions', 'subscription_events', 'invoices', 'feature_entitlements']) {
    const { data, error } = await client.from(t).select('*').limit(50);
    const n = error ? `ERR ${error.message.slice(0, 40)}` : String((data ?? []).length);
    console.log(`    ${t.padEnd(24)} ${n} 行`);
  }

  // 是否有任何 SQL/脚本给 subscription_plans 灌数据
  const seeds: string[] = [];
  for (const f of walk(join(ROOT, 'scripts'))) {
    if (!/\.(sql|ts|mts|mjs|tsx)$/.test(f)) continue;
    const text = readFileSync(f, 'utf8');
    if (/insert\s+into\s+(public\.)?subscription_plans/i.test(text)) {
      seeds.push(f.replace(ROOT + '\\', '').replace(/\\/g, '/'));
    }
  }
  console.log(`    给 subscription_plans 灌数据的脚本: ${seeds.length === 0 ? '**无**' : seeds.join(', ')}`);

  // ---- 2. dashboard 是否硬编码增长数字 -------------------------------------
  console.log('');
  console.log('[2] dashboard 的增长数字是计算出来的还是写死的');
  const dashSrc = readFileSync(join(ROOT, 'src/app/api/dashboard/route.ts'), 'utf8');
  const lines = dashSrc.split('\n');
  const suspicious = lines
    .map((l, i) => ({ n: i + 1, l: l.trim() }))
    .filter((x) => /(ordersDelta|customersDelta|ratingDelta|revenueDelta)\s*:/.test(x.l));
  for (const s of suspicious) console.log(`    L${s.n}: ${s.l}`);
  const hardcoded = suspicious.filter((x) => /:\s*-?\d+(\.\d+)?\s*,?\s*$/.test(x.l));
  console.log(`    其中**直接写死数字**的: ${hardcoded.length} 处`);
  const inventedCustomers = lines.map((l, i) => ({ n: i + 1, l: l.trim() }))
    .filter((x) => /todayCustomers/.test(x.l));
  for (const s of inventedCustomers) console.log(`    L${s.n}: ${s.l}`);

  // ---- 3. signup 是否建 settings 行 ---------------------------------------
  console.log('');
  console.log('[3] signup 是否创建 settings 行');
  const signupSrc = readFileSync(join(ROOT, 'src/app/api/auth/signup/route.ts'), 'utf8');
  console.log(`    signup/route.ts 中提到 settings: ${/settings/.test(signupSrc) ? '是' : '**否**'}`);
  const authSrc = readFileSync(join(ROOT, 'src/lib/auth.ts'), 'utf8');
  const authSettings = /from\(['"]settings['"]\)/.test(authSrc);
  console.log(`    auth.ts 中写 settings 表: ${authSettings ? '是' : '**否**'}`);
  const { data: settingsRows } = await client.from('settings').select('tenant_id, business_id').limit(50);
  console.log(`    真实库 settings 行数: ${(settingsRows ?? []).length}（tenants 行数见下）`);
  const { data: tenantRows } = await client.from('tenants').select('id, name').limit(50);
  console.log(`    真实库 tenants 行数: ${(tenantRows ?? []).length}`);
  for (const t of tenantRows ?? []) {
    console.log(`      tenant ${String((t as Record<string, unknown>).name)}`);
  }

  console.log('');
  console.log('='.repeat(86));
  return 0;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 800).unref(); })
  .catch((e: unknown) => { console.error('崩溃:', e); process.exitCode = 2; });
