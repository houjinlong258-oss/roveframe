/**
 * Phase 16 任务 1 验收 —— 仪表盘**不编造**，在真实运行的服务上取证。
 *
 * ## 为什么需要两个商户
 *
 * 只测"零数据账户的 delta 是 null"会有一个漏洞：如果实现被改成**永远返回 null**，
 * 那个测试依然全绿，而商家永远看不到增长。所以必须有阳性对照 —— 一个**真的有数据**
 * 的账户，delta 必须算出非 null 的真实值。
 *
 *   阴性对照（零数据）：新注册商户 → 四个 delta 必须为 null，不得是 8.4/5.2/1.2
 *   阳性对照（有数据）：给该商户插入跨越两个区间的真实订单 → delta 必须是算出来的
 *
 * 阳性对照用**同一个**商户，避免多留一条孤儿链。
 *
 * ## 会写入真实库
 *
 *   1 个 tenant + 1 个 business + 1 个 auth 用户（signup 的正常语义）
 *   + 5 条 orders（阳性对照的输入数据，created_at 手工设定在两个区间内）
 *
 * 跑完请清理：
 *   npx tsx scripts/_cleanup_test_residue.mts          # 先看计划（零写入）
 *   npx tsx scripts/_cleanup_test_residue.mts --apply  # 确认后删除
 *
 * 用法：npx tsx scripts/_verify_dashboard_no_fabrication.mts
 */
import * as supabaseModule from '../src/storage/database/supabase-client';

type Row = Record<string, unknown>;
type Res = { data: Row[] | null; error: { message: string } | null };

function resolveExport<T>(mod: unknown, name: string): T {
  const m = mod as Record<string, unknown>;
  if (m?.[name] !== undefined) return m[name] as T;
  for (const carrier of ['default', 'module.exports']) {
    const bag = m?.[carrier] as Record<string, unknown> | undefined;
    if (bag?.[name] !== undefined) return bag[name] as T;
  }
  throw new Error(`cannot resolve export '${name}'`);
}

const getSupabaseClient = resolveExport<() => {
  from(t: string): {
    insert(rows: Row[]): Promise<Res>;
    select(c: string): { eq(c: string, v: string): { limit(n: number): Promise<Res> } };
  };
}>(supabaseModule, 'getSupabaseClient');

const BASE = `http://127.0.0.1:${process.env.WEB_PORT || '5055'}`;
const CLIENT_IP = '203.0.113.77';

interface Observation { step: string; detail: string; ok: boolean }
const log: Observation[] = [];
function record(step: string, detail: string, ok: boolean): void {
  log.push({ step, detail, ok });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${step} — ${detail}`);
}

const jar = new Map<string, string>();
function jarHeader(): string { return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
function absorbCookies(res: Response): void {
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}
async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('x-forwarded-for', CLIENT_IP);
  const cookie = jarHeader();
  if (cookie) headers.set('cookie', cookie);
  const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: 'manual' });
  absorbCookies(res);
  return res;
}

/** 本地日零点往回 N 天，返回当天中午（避免边界时刻落进相邻区间） */
function daysAgoNoon(n: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
}

interface KpiShape {
  todayRevenue?: number; todayOrders?: number; todayCustomers?: number;
  revenueDelta?: number | null; ordersDelta?: number | null;
  customersDelta?: number | null; ratingDelta?: number | null;
}
interface DashShape { kpi?: KpiShape; basis?: Row; demo?: boolean; error?: string }

const FORBIDDEN = [8.4, 5.2, 1.2];

async function main(): Promise<number> {
  console.log('='.repeat(88));
  console.log('Phase 16 任务 1 验收 — 仪表盘不编造增长数字（真实服务）');
  console.log('='.repeat(88));
  console.log(`目标: ${BASE}`);
  console.log('');

  // ---- 0. 服务可达 -------------------------------------------------------
  try {
    const res = await call('/api/health');
    record('服务可达', `HTTP ${res.status}`, res.status === 200 || res.status === 503);
  } catch (err) {
    console.log(`服务不可达: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  console.log('');

  // ---- 1. 注册一个全新商户（零数据账户） ---------------------------------
  console.log('[1] 零数据账户（新注册）');
  const stamp = Date.now();
  const email = `phase16-dash-${stamp}@example.com`;
  const password = `Rove!${stamp}Aa9`;
  const signupRes = await call('/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email, password, business_name: `Phase16 Dash ${stamp}`,
      industry: 'restaurant', language: 'en', currency: 'USD',
    }),
  });
  const signupBody = (await signupRes.json().catch(() => ({}))) as Row;
  record('注册返回 201', `HTTP ${signupRes.status}`, signupRes.status === 201);
  if (signupRes.status !== 201) {
    console.log(`      注册失败，无法继续: ${JSON.stringify(signupBody).slice(0, 240)}`);
    return 2;
  }
  const tenantId = String(signupBody.tenant_id ?? '');
  const businessId = String(signupBody.business_id ?? '');
  console.log(`      tenant_id=${tenantId}`);
  console.log(`      business_id=${businessId}`);
  console.log('');

  const dashRes = await call('/api/dashboard?range=7');
  const dash = (await dashRes.json().catch(() => ({}))) as DashShape;
  record('零数据 /api/dashboard 200', `HTTP ${dashRes.status}`, dashRes.status === 200);
  console.log(`      kpi=${JSON.stringify(dash.kpi)}`);
  console.log(`      basis=${JSON.stringify(dash.basis)}`);

  const zeroKpi = dash.kpi ?? {};
  record('零数据：ordersDelta 为 null', `值=${JSON.stringify(zeroKpi.ordersDelta)}`, zeroKpi.ordersDelta === null);
  record('零数据：customersDelta 为 null', `值=${JSON.stringify(zeroKpi.customersDelta)}`, zeroKpi.customersDelta === null);
  record('零数据：ratingDelta 为 null', `值=${JSON.stringify(zeroKpi.ratingDelta)}`, zeroKpi.ratingDelta === null);
  record('零数据：revenueDelta 为 null', `值=${JSON.stringify(zeroKpi.revenueDelta)}`, zeroKpi.revenueDelta === null);

  // 负向对照：旧常数绝不允许出现在任何 delta 上（含"恰好等于"这种巧合）
  const hitForbidden = FORBIDDEN.filter((v) =>
    [zeroKpi.ordersDelta, zeroKpi.customersDelta, zeroKpi.ratingDelta, zeroKpi.revenueDelta].includes(v));
  record('零数据：不得出现历史常数 8.4/5.2/1.2', `命中=${JSON.stringify(hitForbidden)}`, hitForbidden.length === 0);

  // 负向对照：今日客流不得等于 订单数 × 1.8（零数据时为 0，此断言在阳性对照里更有力）
  record('零数据：todayCustomers 是真实计数（0）', `值=${JSON.stringify(zeroKpi.todayCustomers)}`, zeroKpi.todayCustomers === 0);
  record('零数据：并非演示数据', `demo=${JSON.stringify(dash.demo)}`, dash.demo === undefined);
  console.log('');

  // ---- 2. 阳性对照：插入跨越两个区间的真实订单 ---------------------------
  console.log('[2] 阳性对照（同一商户，插入真实订单后必须算出真实 delta）');
  const client = getSupabaseClient();
  const rows: Row[] = [
    { total: 100, customer_id: null, created_at: daysAgoNoon(0) },
    { total: 80, customer_id: null, created_at: daysAgoNoon(0) },
    { total: 20, customer_id: null, created_at: daysAgoNoon(0) },
    { total: 50, customer_id: null, created_at: daysAgoNoon(8) },
    { total: 25, customer_id: null, created_at: daysAgoNoon(10) },
  ].map((r, i) => ({
    ...r,
    id: crypto.randomUUID(),
    tenant_id: tenantId,
    business_id: businessId,
    order_no: `P16-${stamp}-${i}`,
    channel: 'dine_in',
    status: 'completed',
    source: 'native',
    items: [{ name: 'Fixture item', qty: 1, price: Number(r.total) }],
    tip: 0,
  }));

  const ins = await client.from('orders').insert(rows);
  record('插入 5 条真实订单', ins.error ? `ERR ${ins.error.message}` : 'OK', !ins.error);
  if (ins.error) return 2;

  const dash2Res = await call('/api/dashboard?range=7');
  const dash2 = (await dash2Res.json().catch(() => ({}))) as DashShape;
  const kpi2 = dash2.kpi ?? {};
  console.log(`      kpi=${JSON.stringify(kpi2)}`);
  console.log(`      basis=${JSON.stringify(dash2.basis)}`);

  // 本期 = 今日起往前 7 天（3 单，200）；对比期 = 再往前 7 天（2 单，75）
  record('有数据：todayOrders 真实（3）', `值=${JSON.stringify(kpi2.todayOrders)}`, kpi2.todayOrders === 3);
  record('有数据：todayRevenue 真实（200）', `值=${JSON.stringify(kpi2.todayRevenue)}`, kpi2.todayRevenue === 200);
  record('有数据：todayCustomers 是真实客户数（0，因夹具无 customer_id）',
    `值=${JSON.stringify(kpi2.todayCustomers)}`, kpi2.todayCustomers === 0);
  record('有数据：todayCustomers ≠ 订单数 × 1.8（旧算式会给 5）',
    `todayCustomers=${JSON.stringify(kpi2.todayCustomers)} 订单数×1.8=5`, kpi2.todayCustomers !== 5);
  // 注意区间口径：range=7 ⇒ 本期是"今日起往前 7 天"（3 单 / 200.00），
  // 对比期是再往前 7 天（2 单 / 75.00）。夹具里 0 天前的 3 单落在本期，
  // 8 / 10 天前的 2 单落在对比期。
  record('有数据：ordersDelta 是算出来的（本期 3 单 vs 对比期 2 单 = +50）',
    `值=${JSON.stringify(kpi2.ordersDelta)}`, kpi2.ordersDelta === 50);
  record('有数据：revenueDelta 是算出来的（本期 200.00 vs 对比期 75.00 = +166.7）',
    `值=${JSON.stringify(kpi2.revenueDelta)}`, kpi2.revenueDelta === 166.7);

  const basis = dash2.basis as Row | undefined;
  const prior = basis?.prior as Row | undefined;
  record('basis 如实报告对比期（2 单 / 75.00）',
    `prior=${JSON.stringify(prior)}`, prior?.orders === 2 && prior?.revenue === 75);
  record('basis.hasPriorBasis 为 true', `值=${JSON.stringify(basis?.hasPriorBasis)}`, basis?.hasPriorBasis === true);

  const hit2 = FORBIDDEN.filter((v) =>
    [kpi2.ordersDelta, kpi2.customersDelta, kpi2.ratingDelta, kpi2.revenueDelta].includes(v));
  record('有数据：不得出现历史常数 8.4/5.2/1.2', `命中=${JSON.stringify(hit2)}`, hit2.length === 0);

  // ---- 3. 汇总 -----------------------------------------------------------
  const failed = log.filter((l) => !l.ok);
  console.log('');
  console.log('='.repeat(88));
  console.log(`合计 ${log.length - failed.length}/${log.length} 通过`);
  if (failed.length) {
    console.log('失败项:');
    for (const f of failed) console.log(`  - ${f.step}: ${f.detail}`);
  }
  console.log('');
  console.log('本次运行写入：1 tenant / 1 business / 1 auth 用户 / 5 条 orders');
  console.log('清理：npx tsx scripts/_cleanup_test_residue.mts --apply');
  console.log('='.repeat(88));
  return failed.length ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 1_500).unref(); })
  .catch((e: unknown) => { console.error('崩溃:', e); process.exitCode = 2; });
