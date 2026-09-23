/**
 * 只读审计脚本：**数据层边界实测**（零写入，只发 GET）。
 *
 * 回答两个问题，都不靠读代码：
 *   1. 用**公开的 anon key**（会随前端下发到浏览器的那个）能读到多少租户数据？
 *      RLS 若真的生效，anon 在启用 RLS 且无 anon 策略的表上只能看到 0 行。
 *      RLS 若没启用，anon 就能读到全部行 —— 这是可以直接量的。
 *   2. `auth.users` 里有多少账号在 `public.users` 没有对应行（孤儿账号）。
 *
 * 阳性对照：同样的问题用 service_role 再问一遍。
 * service_role 若也读到 0 行，说明"0 行"是表名错/网络错/RLS 把 service_role 也拦了，
 * 而不是"RLS 生效"—— 没有这个对照，anon=0 行是一个无法证伪的结论。
 *
 * 凭据从 docker/deploy.env 读，**不打印任何密钥**。
 * 用法：node scripts/_audit_data_layer.mjs
 */
import { readFileSync } from 'node:fs';

const env = {};
for (const line of readFileSync('docker/deploy.env', 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(line);
  if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const URL_BASE = env.COZE_SUPABASE_URL;
const ANON = env.COZE_SUPABASE_ANON_KEY;
const SERVICE = env.COZE_SUPABASE_SERVICE_ROLE_KEY;
if (!URL_BASE || !ANON || !SERVICE) {
  console.error('missing credentials in docker/deploy.env');
  process.exit(2);
}
console.log(`project host = ${new URL(URL_BASE).host}`);

const TABLES = [
  'tenants', 'tenant_subscriptions', 'businesses', 'users', 'staff', 'orders',
  'order_items', 'customers', 'payments', 'payment_events', 'integration_configs',
  'model_configs', 'email_accounts', 'audit_events', 'audit_logs', 'chat_sessions',
  'knowledge_docs', 'customer_accounts', 'customer_sessions', 'customer_addresses',
  'delivery_orders', 'delivery_positions', 'staff_attendance', 'staff_care_notes',
  'public_sites', 'agent_approvals', 'notification_outbox', 'ai_usage_ledger',
];

async function probe(table, key) {
  const url = `${URL_BASE}/rest/v1/${table}?select=*&limit=1`;
  try {
    const res = await fetch(url, {
      headers: { apikey: key, authorization: `Bearer ${key}`, prefer: 'count=exact' },
    });
    const body = await res.text();
    let rows = null;
    try { rows = JSON.parse(body); } catch { /* not json */ }
    const range = res.headers.get('content-range') || '';
    const total = range.includes('/') ? range.split('/')[1] : '?';
    return {
      status: res.status,
      total,
      rows: Array.isArray(rows) ? rows.length : -1,
      err: Array.isArray(rows) ? '' : body.slice(0, 90).replace(/\s+/g, ' '),
    };
  } catch (e) {
    return { status: -1, total: '?', rows: -1, err: String(e?.message ?? e) };
  }
}

console.log('\n=== anon key vs service_role on the same tables (limit=1, count=exact) ===');
console.log('table'.padEnd(24), 'anon:status'.padEnd(13), 'anon:total'.padEnd(12), 'svc:status'.padEnd(12), 'svc:total');
const leaks = [];
for (const t of TABLES) {
  const a = await probe(t, ANON);
  const s = await probe(t, SERVICE);
  console.log(
    t.padEnd(24),
    String(a.status).padEnd(13),
    String(a.total).padEnd(12),
    String(s.status).padEnd(12),
    String(s.total),
  );
  // 泄漏判定：service_role 能读到 >0 行，而 anon 也读到了 >0 行
  const svcRows = Number(s.total);
  const anonRows = Number(a.total);
  if (Number.isFinite(svcRows) && svcRows > 0 && Number.isFinite(anonRows) && anonRows > 0) {
    leaks.push({ table: t, anonRows, svcRows });
  }
  if (a.status >= 400 || s.status >= 400) {
    console.log(`   err anon=${a.err} | svc=${s.err}`);
  }
}
console.log(`\nANON_READS_ROWS_ON=${leaks.length} table(s) -> ${JSON.stringify(leaks)}`);

// ---- auth.users vs public.users（GoTrue admin API + PostgREST） ----
console.log('\n=== orphan auth users ===');
let authUsers = [];
try {
  const res = await fetch(`${URL_BASE}/auth/v1/admin/users?per_page=200`, {
    headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}` },
  });
  const body = await res.json();
  authUsers = body.users ?? [];
  console.log(`auth_status=${res.status} auth_users=${authUsers.length}`);
} catch (e) {
  console.log(`auth query failed: ${e?.message}`);
}
let publicUsers = [];
try {
  const res = await fetch(`${URL_BASE}/rest/v1/users?select=user_id,email,role,tenant_id`, {
    headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}` },
  });
  publicUsers = await res.json();
  console.log(`public_users_status=${res.status} public_users=${Array.isArray(publicUsers) ? publicUsers.length : 'n/a'}`);
} catch (e) {
  console.log(`public.users query failed: ${e?.message}`);
}
if (Array.isArray(publicUsers)) {
  const ids = new Set(publicUsers.map((u) => u.user_id));
  const orphans = authUsers.filter((u) => !ids.has(u.id));
  console.log(`ORPHAN_AUTH_USERS=${orphans.length}`);
  for (const o of orphans) {
    console.log(`   ${o.id} ${o.email ?? '(no email)'} created=${o.created_at} confirmed=${Boolean(o.email_confirmed_at)}`);
  }
  const dupes = new Map();
  for (const u of publicUsers) dupes.set(u.email, (dupes.get(u.email) ?? 0) + 1);
  const multi = [...dupes.entries()].filter(([, n]) => n > 1);
  console.log(`public.users duplicate emails: ${JSON.stringify(multi)}`);
}

// ---- tenant / subscription inventory ----
console.log('\n=== tenants + subscriptions ===');
for (const q of ['tenants?select=id,name,slug,created_at', 'tenant_subscriptions?select=tenant_id,status,plan_id,current_period_end', 'businesses?select=id,name,tenant_id']) {
  const res = await fetch(`${URL_BASE}/rest/v1/${q}`, {
    headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}` },
  });
  const body = await res.json();
  console.log(`${q.split('?')[0]}: ${Array.isArray(body) ? JSON.stringify(body).slice(0, 400) : String(body).slice(0, 200)}`);
}
