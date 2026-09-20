/**
 * Phase 16 任务 2/3/5 验收 —— 真实运行的服务上取证。
 *
 * 覆盖（每条都是"真实 HTTP + 真实库"，不是静态断言）：
 *
 *   任务 3  新注册商家的门店名与货币、仪表盘零数据 delta
 *   任务 2  订阅门禁：trialing 可写 → 置为 suspended 后被拒（402）→ 恢复后可用
 *   任务 5  扫码点餐幂等：同一 Idempotency-Key 发两次，库里只有一单
 *
 * ## 为什么用同一个商户走完三件事
 *
 * 注册会留下 tenant + business + auth 用户。为了少留残留，本脚本只注册**一个**
 * 商户，把它依次用于三组断言。跑完请清理：
 *
 *   npx tsx scripts/_cleanup_test_residue.mts --apply
 *
 * 用法：npx tsx scripts/_verify_phase16_core.mts
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

interface DbClient {
  from(t: string): {
    select(c: string, o?: unknown): {
      eq(c: string, v: string): { maybeSingle(): Promise<Res>; limit(n: number): Promise<Res> };
      limit(n: number): Promise<Res>;
    };
    insert(rows: Row[] | Row): Promise<Res>;
    update(patch: Row): { eq(c: string, v: string): Promise<Res> & { eq(c: string, v: string): Promise<Res> } };
    upsert(rows: Row[], o?: unknown): Promise<Res>;
  };
}

const getSupabaseClient = resolveExport<() => DbClient>(supabaseModule, 'getSupabaseClient');

const BASE = `http://127.0.0.1:${process.env.WEB_PORT || '5055'}`;
const CLIENT_IP = '203.0.113.91';

interface Observation { step: string; detail: string; ok: boolean }
const log: Observation[] = [];
function record(step: string, detail: string, ok: boolean): void {
  log.push({ step, detail, ok });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${step} — ${detail}`);
}
function info(message: string): void { console.log(`        ${message}`); }

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
const jsonHeaders = (): HeadersInit => ({ 'content-type': 'application/json' });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<number> {
  console.log('='.repeat(90));
  console.log('Phase 16 任务 2/3/5 验收 — 真实服务 + 真实库');
  console.log('='.repeat(90));
  console.log(`目标: ${BASE}`);
  console.log('');

  const db = getSupabaseClient();

  // ---- 0. 服务可达 --------------------------------------------------------
  try {
    const res = await call('/api/health');
    record('服务可达', `HTTP ${res.status}`, res.status === 200 || res.status === 503);
  } catch (err) {
    console.log(`服务不可达: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  console.log('');

  // ---- 1. 注册 ------------------------------------------------------------
  console.log('[1] 注册新商户（任务 2/3 的主体）');
  const stamp = Date.now();
  const email = `phase16-core-${stamp}@example.com`;
  const password = `Rove!${stamp}Aa9`;
  const businessName = `Phase16 Cafe ${stamp}`;
  const signupRes = await call('/api/auth/signup', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      email, password, business_name: businessName,
      industry: 'restaurant', language: 'zh', currency: 'CNY',
    }),
  });
  const signupBody = (await signupRes.json().catch(() => ({}))) as Row;
  record('注册 201', `HTTP ${signupRes.status}`, signupRes.status === 201);
  if (signupRes.status !== 201) {
    console.log(`      失败详情: ${JSON.stringify(signupBody).slice(0, 300)}`);
    return 2;
  }
  const tenantId = String(signupBody.tenant_id ?? '');
  const businessId = String(signupBody.business_id ?? '');
  info(`tenant=${tenantId} business=${businessId}`);
  info(`signup.subscription=${JSON.stringify(signupBody.subscription)}`);

  // ---- 2. 任务 3：settings 行 / 门店名 / 货币 ----------------------------
  console.log('');
  console.log('[2] 任务 3 — 注册首日路径');
  const { data: settingsRows } = await db.from('settings')
    .select('business, locale').eq('tenant_id', tenantId).limit(5);
  const settingsRow = (settingsRows ?? [])[0] as Row | undefined;
  info(`settings.business=${JSON.stringify(settingsRow?.business)}`);
  info(`settings.locale=${JSON.stringify(settingsRow?.locale)}`);
  record('注册建了 settings 行（不是 0 行）', `行数=${(settingsRows ?? []).length}`, (settingsRows ?? []).length === 1);

  // 建一张桌码，让公开菜单可访问。
  // public_token 必须匹配 `/^[a-f0-9]{32,64}$/i`（resolvePublicStore 的校验），
  // 因此这里用 32 位十六进制，而不是随便一个字符串 —— 第一次运行就是踩了这个。
  const publicToken = `abcdef${stamp.toString(16).padStart(8, '0')}`.padEnd(32, '0').slice(0, 32);
  const qrInsert = await db.from('store_qr_codes').insert({
    tenant_id: tenantId, business_id: businessId,
    table_no: 'T1', public_token: publicToken, remark: 'Phase16',
    scan_count: 0, is_active: true,
  });
  record('建桌码行（公开菜单的前提）', qrInsert.error ? `ERR ${qrInsert.error.message}` : 'OK', !qrInsert.error);

  const menuRes = await call(`/api/store/menu?token=${publicToken}`);
  const menuBody = (await menuRes.json().catch(() => ({}))) as Row;
  const store = (menuBody.store ?? {}) as Row;
  info(`菜单响应的 store=${JSON.stringify(store)}`);
  record('公开菜单返回真实店铺名（不是字面量 "Store"）',
    `name=${JSON.stringify(store.name)}`,
    store.name === businessName);
  record('菜单货币来自注册时选择（CNY）而不是默认 USD',
    `currency=${JSON.stringify(store.currency)}`, store.currency === 'CNY');

  const dashRes = await call('/api/dashboard?range=7');
  const dash = (await dashRes.json().catch(() => ({}))) as Row;
  info(`dashboard.kpi=${JSON.stringify(dash.kpi)}`);
  const zeroKpi = (dash.kpi ?? {}) as Row;
  const deltas = [zeroKpi.ordersDelta, zeroKpi.customersDelta, zeroKpi.ratingDelta, zeroKpi.revenueDelta];
  record('零数据账户：四个 delta 都是 null（不是 8.4/5.2/1.2，也不是 0）',
    `deltas=${JSON.stringify(deltas)}`, deltas.every((d) => d === null));
  record('零数据账户：todayCustomers 是真实计数（0）而不是订单数×1.8',
    `todayCustomers=${JSON.stringify(zeroKpi.todayCustomers)}`, zeroKpi.todayCustomers === 0);
  record('仪表盘响应不是演示数据（无 demo 标记）', `demo=${JSON.stringify(dash.demo)}`, dash.demo === undefined);
  console.log('');

  // ---- 3. 任务 2：权益门禁 ------------------------------------------------
  console.log('[3] 任务 2 — 权益门禁（trialing → suspended → 恢复）');
  const { data: subRows } = await db.from('tenant_subscriptions')
    .select('id, status, plan_id, current_period_end').eq('tenant_id', tenantId).limit(1);
  const sub = (subRows ?? [])[0] as Row | undefined;
  info(`subscription=${JSON.stringify(sub)}`);
  record('注册建了 trialing 订阅且带到期时间',
    `status=${sub?.status} period_end=${sub?.current_period_end}`,
    sub?.status === 'trialing' && typeof sub?.current_period_end === 'string');

  // trialing 期内：门禁路径上的写操作应当放行
  const gatedWrite = () => call('/api/emails/send', {
    method: 'POST',
    headers: jsonHeaders(),
    // /api/emails/send 的真实入参是 { emailId, reply }（它把 AI 草稿回给客户）。
    // 门禁在鉴权之后、入参校验之前生效，因此即使这里必然 400/404，
    // "被订阅拒绝时是 402、允许时是 400/404"这个对照依然成立。
    body: JSON.stringify({ emailId: 'phase16-gate-probe', reply: 'gate check' }),
  });
  const writeWhileTrialing = await gatedWrite();
  const trialingBody = (await writeWhileTrialing.json().catch(() => ({}))) as Row;
  info(`trialing 期内 /api/emails/send → HTTP ${writeWhileTrialing.status} ${JSON.stringify(trialingBody).slice(0, 160)}`);
  record('trialing 期内门禁路径的写操作放行（不是 402）',
    `HTTP ${writeWhileTrialing.status}`, writeWhileTrialing.status !== 402);

  // 反面对照：内部写操作不受订阅门禁影响（欠费商家仍能改自己的设置/订阅推送）。
  // 用 /api/notifications/push：它是真正的内部写、入参简单、缺字段时 400 而不落库。
  const internalWrite = () => call('/api/notifications/push', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({}),
  });
  const internalWhileTrialing = await internalWrite();
  info(`内部写操作 /api/notifications/push → HTTP ${internalWhileTrialing.status}`);
  record('内部写操作不在门禁范围内（放行）',
    `HTTP ${internalWhileTrialing.status}`, internalWhileTrialing.status !== 402);

  // 置为 suspended（无平台管理员会话，直接改库；与 /api/admin/tenants/[id]
  // 的 suspend 分支写的是同一列同一值）
  const { error: suspendError } = await (db.from('tenant_subscriptions')
    .update({ status: 'suspended', updated_at: new Date().toISOString() })
    .eq('tenant_id', tenantId) as unknown as Promise<Res>);
  record('把订阅置为 suspended（直接改库，模拟平台停用）',
    suspendError ? `ERR ${suspendError.message}` : 'OK', !suspendError);
  // 判定缓存 TTL 5 秒：等它过期，证明"改状态后确实会生效"
  await wait(6000);

  const writeWhileSuspended = await gatedWrite();
  const blockedBody = (await writeWhileSuspended.json().catch(() => ({}))) as Row;
  info(`被拒响应=${JSON.stringify(blockedBody).slice(0, 240)}`);
  record('suspended 后门禁路径的写操作被拒（402）',
    `HTTP ${writeWhileSuspended.status}`, writeWhileSuspended.status === 402);
  record('拒绝原因可读（code 有值）',
    `code=${JSON.stringify(blockedBody.code)}`, blockedBody.code !== undefined);

  const readWhileSuspended = await call('/api/dashboard?range=7');
  record('suspended 时读操作仍放行（商家必须能读自己的数据）',
    `HTTP ${readWhileSuspended.status}`, readWhileSuspended.status === 200);

  // 内部写同样不受影响（停用也只停"平台卖的服务"，不停"商家自己的数据"）
  const internalWhileSuspended = await internalWrite();
  info(`suspended 时内部写 /api/notifications/push → HTTP ${internalWhileSuspended.status}`);
  record('suspended 时内部写操作仍放行（不是 402）',
    `HTTP ${internalWhileSuspended.status}`, internalWhileSuspended.status !== 402);

  // 恢复 active 后写操作应再次放行
  const { error: resumeError } = await (db.from('tenant_subscriptions')
    .update({ status: 'active', updated_at: new Date().toISOString() })
    .eq('tenant_id', tenantId) as unknown as Promise<Res>);
  record('恢复为 active', resumeError ? `ERR ${resumeError.message}` : 'OK', !resumeError);
  await wait(6000);
  const writeAfterResume = await gatedWrite();
  info(`恢复后 /api/emails/send → HTTP ${writeAfterResume.status}`);
  record('恢复后门禁路径的写操作再次放行',
    `HTTP ${writeAfterResume.status}`, writeAfterResume.status !== 402);
  console.log('');

  // ---- 4. 任务 5：订单幂等 ------------------------------------------------
  console.log('[4] 任务 5 — 扫码点餐幂等（同一 Idempotency-Key 发两次）');
  const productId = `p16-prod-${stamp}`;
  const prodInsert = await db.from('products').insert({
    id: productId, tenant_id: tenantId, business_id: businessId,
    name: 'Phase16 Test Dish', category: 'main', price: 12.5,
    status: 'active', sales_count: 0, source: 'native',
  });
  record('建一件商品（下单的前提）', prodInsert.error ? `ERR ${prodInsert.error.message}` : 'OK', !prodInsert.error);

  const idemKey = `phase16-idem-${stamp}`;
  const orderPayload = {
    token: publicToken,
    note: 'phase16 idempotency check',
    tip_amount: 0,
    tip_percent: null,
    items: [{ product_id: productId, qty: 2 }],
  };
  const first = await call('/api/store/orders', {
    method: 'POST',
    headers: { ...jsonHeaders(), 'Idempotency-Key': idemKey },
    body: JSON.stringify(orderPayload),
  });
  const firstBody = (await first.json().catch(() => ({}))) as Row;
  const firstOrder = (firstBody.order ?? {}) as Row;
  info(`第一单: HTTP ${first.status} order_no=${String(firstOrder.order_no)}`);
  record('第一次下单成功且非幂等命中',
    `HTTP ${first.status} idempotent=${JSON.stringify(firstBody.idempotent)}`,
    first.status === 200 && firstBody.idempotent === undefined);

  const second = await call('/api/store/orders', {
    method: 'POST',
    headers: { ...jsonHeaders(), 'Idempotency-Key': idemKey },
    body: JSON.stringify(orderPayload),
  });
  const secondBody = (await second.json().catch(() => ({}))) as Row;
  const secondOrder = (secondBody.order ?? {}) as Row;
  info(`第二单: HTTP ${second.status} order_no=${String(secondOrder.order_no)} idempotent=${JSON.stringify(secondBody.idempotent)}`);
  record('第二次同 key 命中幂等，返回同一张订单',
    `order_no 相同=${firstOrder.order_no === secondOrder.order_no}`,
    second.status === 200 && secondBody.idempotent === true
      && firstOrder.order_no === secondOrder.order_no);

  const { data: orderRows } = await db.from('orders')
    .select('id, order_no, external_id, source, table_no, total')
    .eq('tenant_id', tenantId).limit(20);
  const matching = (orderRows ?? []).filter((o) => o.external_id === idemKey);
  info(`库中 external_id=${idemKey} 的订单数=${matching.length}`);
  record('库中只有一单（真实落库计数，不是响应自述）', `count=${matching.length}`, matching.length === 1);

  // 反面对照：同 key 不同内容必须被拒（否则顾客加单会被静默吞掉）
  const conflict = await call('/api/store/orders', {
    method: 'POST',
    headers: { ...jsonHeaders(), 'Idempotency-Key': idemKey },
    body: JSON.stringify({ ...orderPayload, items: [{ product_id: productId, qty: 5 }] }),
  });
  const conflictBody = (await conflict.json().catch(() => ({}))) as Row;
  info(`同 key 改数量: HTTP ${conflict.status} error=${JSON.stringify(conflictBody.error)}`);
  record('同 key 不同内容被拒（409），不静默丢弃顾客的加单',
    `HTTP ${conflict.status} error=${JSON.stringify(conflictBody.error)}`,
    conflict.status === 409 && conflictBody.error === 'idempotency_key_conflict');

  // 新订单通知（任务 5）
  const { data: notifRows } = await db.from('notifications')
    .select('title, type, priority').eq('tenant_id', tenantId).limit(10);
  const orderNotifs = (notifRows ?? []).filter((n) => String(n.type) === 'QR_ORDER_PLACED');
  info(`QR 订单通知行数=${orderNotifs.length}，内容=${JSON.stringify(orderNotifs[0] ?? null)}`);
  record('新订单写入了商户通知（叫得动厨房）', `count=${orderNotifs.length}`, orderNotifs.length > 0);
  console.log('');

  // ---- 5. 汇总 ------------------------------------------------------------
  const failed = log.filter((l) => !l.ok);
  console.log('='.repeat(90));
  console.log(`合计 ${log.length - failed.length}/${log.length} 通过`);
  if (failed.length) {
    console.log('失败项:');
    for (const f of failed) console.log(`  - ${f.step}: ${f.detail}`);
  }
  console.log('');
  console.log('本次写入：1 tenant / 1 business / 1 auth 用户 / 1 settings / 1 订阅 /');
  console.log('          1 桌码 / 1 商品 / 1 订单 / 若干通知 + 客户行');
  console.log('清理：npx tsx scripts/_cleanup_test_residue.mts --apply');
  console.log('='.repeat(90));
  return failed.length ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 1_500).unref(); })
  .catch((e: unknown) => { console.error('崩溃:', e); process.exitCode = 2; });
