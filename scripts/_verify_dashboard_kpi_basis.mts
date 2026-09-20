/**
 * Phase 16 任务 1 取证（只读）：仪表盘 delta 的"计算依据"是否存在。
 *
 * 在改 `src/app/api/dashboard/route.ts` 之前必须回答三个问题，
 * 否则"真实计算"会变成另一种猜测：
 *
 *   1. `orders` 真的有 14 天以上的数据吗？（没有对比期 ⇒ delta 只能为 null）
 *   2. `reviews` 有 `created_at` 列吗？（没有 ⇒ ratingDelta 无法做同期对比）
 *   3. `customers` 有 `created_at` 列吗？（决定 todayCustomers 用哪种真实口径）
 *
 * 全部只读。每个探测都带阴性对照，证明探针**能失败**（本项目规矩）。
 */
import * as supabaseModule from '../src/storage/database/supabase-client';

type Row = Record<string, unknown>;
type Res = { data: Row[] | null; error: { message: string } | null };

const getSupabaseClient = (supabaseModule as unknown as { getSupabaseClient?: () => unknown }).getSupabaseClient
  ?? (supabaseModule as unknown as { default?: { getSupabaseClient?: () => unknown } }).default?.getSupabaseClient;
if (!getSupabaseClient) throw new Error('getSupabaseClient not resolvable');

const ANCHOR_TENANT = '00000000-0000-0000-0000-000000000000';
const ANCHOR_BUSINESS = '00000000-0000-0000-0000-000000000001';

const client = getSupabaseClient!() as {
  from(t: string): { select(c: string): { limit(n: number): Promise<Res>; eq(c: string, v: unknown): { limit(n: number): Promise<Res>; eq(c: string, v: unknown): { limit(n: number): Promise<Res> } } } };
};

function line(s = ''): void { console.log(s); }

async function main(): Promise<number> {
  line('='.repeat(90));
  line('Phase 16 任务 1 取证 — 仪表盘 KPI 的计算依据（只读）');
  line('='.repeat(90));
  line(`现在本机时间: ${new Date().toString()}`);
  line('');

  // ---- 0. 探针有效性对照：证明本脚本的列投影探针**能失败** ----------------
  line('[0] 探针有效性（阴性对照，证明探针能失败）');
  for (const t of ['orders', 'zzz_definitely_not_a_table_9f3a']) {
    const { data, error } = await client.from(t).select('id').limit(1);
    const verdict = error ? `ERROR(${error.message.slice(0, 40)})` : `${(data ?? []).length} 行`;
    line(`    select('id') on ${t.padEnd(32)} -> ${verdict}`);
  }
  line('    （若两者形态相同，说明探针不可败 → 后续结论一律作废）');
  line('');

  // ---- 1. orders：列 + 时间跨度 ------------------------------------------
  line('[1] orders 的列（select * 取真实列名）');
  const { data: oneOrder, error: orderErr } = await client.from('orders').select('*').limit(1);
  if (orderErr) { line(`    ERR ${orderErr.message}`); return 2; }
  const orderCols = Object.keys((oneOrder ?? [{}])[0] ?? {});
  line(`    ${orderCols.join(', ')}`);
  line('');

  line('[2] orders 在锚点租户下的时间分布（近 21 天，按本地日切）');
  const { data: orders, error: ordersErr } = await client
    .from('orders')
    .select('id, total, status, created_at, customer_id')
    .eq('tenant_id', ANCHOR_TENANT)
    .limit(5000);
  if (ordersErr) { line(`    ERR ${ordersErr.message}`); return 2; }
  const allOrders = (orders ?? []) as Row[];
  line(`    锚点租户 orders 总数: ${allOrders.length}`);

  const dayCount = new Map<string, { n: number; revenue: number; customers: Set<string> }>();
  for (const o of allOrders) {
    const d = new Date(String(o.created_at));
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const cur = dayCount.get(key) ?? { n: 0, revenue: 0, customers: new Set<string>() };
    cur.n += 1;
    cur.revenue += Number(o.total ?? 0);
    if (o.customer_id) cur.customers.add(String(o.customer_id));
    dayCount.set(key, cur);
  }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (let i = 20; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const v = dayCount.get(key);
    const mark = i === 0 ? ' <== 今日' : i === 7 ? ' <== 上周同日（对比期）' : '';
    line(`    ${key}  orders=${String(v?.n ?? 0).padStart(4)}  revenue=${(v?.revenue ?? 0).toFixed(2).padStart(9)}  customers=${String(v?.customers.size ?? 0).padStart(3)}${mark}`);
  }
  line('');

  // ---- 3. reviews：是否有 created_at ------------------------------------
  line('[3] reviews 的列（决定 ratingDelta 能否做同期对比）');
  const { data: oneReview, error: revErr } = await client.from('reviews').select('*').limit(1);
  if (revErr) { line(`    ERR ${revErr.message}`); return 2; }
  const reviewCols = Object.keys((oneReview ?? [{}])[0] ?? {});
  line(`    ${reviewCols.join(', ')}`);
  line(`    有 created_at? ${reviewCols.includes('created_at') ? '是' : '否'}`);
  line('');

  // ---- 4. customers：是否有 created_at ----------------------------------
  line('[4] customers 的列（决定 todayCustomers 的口径）');
  const { data: oneCust, error: custErr } = await client.from('customers').select('*').limit(1);
  if (custErr) { line(`    ERR ${custErr.message}`); return 2; }
  const custCols = Object.keys((oneCust ?? [{}])[0] ?? {});
  line(`    ${custCols.join(', ')}`);
  line(`    有 created_at? ${custCols.includes('created_at') ? '是' : '否'}`);
  line('');

  line('='.repeat(90));
  line('判读规则：');
  line('  - 若对比期（上周同日 / 上 7 日）无任何数据 → delta 无依据，必须返回 null。');
  line('  - 若 reviews 无 created_at → ratingDelta 只能用全量评分（不可比）→ 返回 null。');
  line('  - 若 customers 无 created_at → todayCustomers 取"今日订单的 distinct customer_id"。');
  line('='.repeat(90));
  return 0;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 1_500).unref(); })
  .catch((e: unknown) => { console.error('崩溃:', e); process.exitCode = 2; });
