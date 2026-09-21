/**
 * 注册回滚修复的**决定性验证**（真实 HTTP + 真实数据库）。
 *
 * ## 判据不是"返回了 409"
 *
 * 只断言状态码不够：一个"返回 409 但照样建了租户"的实现同样能通过。
 * 因此这里同时断言**副作用为零** —— 租户数在前后必须一模一样。
 *
 * 这正是修复前实测到的缺陷形态：返回 500（用户不知道怎么办），
 * 而库里多了一个 businesses=1 / users=0 / settings=0 的孤儿租户。
 *
 * 三段：
 *   A. 已注册邮箱注册       → 期望 409，且租户数不变（负向对照的核心）
 *   B. 全新邮箱注册         → 期望 201，租户数 +1（证明正常路径没被改坏）
 *   C. 新账号随即登录       → 期望 200（证明 B 建的账号真能用）
 *
 * 用法：
 *   $env:PGHOST=...; $env:PGUSER=...; $env:PGPASSWORD=...
 *   node scripts/_verify_signup_rollback.mjs [baseUrl] [existingEmail]
 */
import { Pool } from 'pg';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5067';
const EXISTING_EMAIL = process.argv[3] ?? 'houjinlong258@gmail.com';

/**
 * 本脚本请求使用的来源 IP（`X-Forwarded-For`）。
 *
 * 为什么需要它：注册与登录都按 `auth:signup:ip:<getClientIp()>` /
 * `auth:login:ip:<…>` 计数，而 `getClientIp`（src/lib/rate-limit.ts:176）先看
 * `x-forwarded-for`。本机直连时没有代理设置这个头，于是**所有**直连调用方
 * 共用同一个 IP 桶 —— 反复跑本脚本会把**正确密码**的登录一起锁进 429
 * （实测：第二次运行时报 `retryAfterSec=862`）。
 *
 * 与 `_verify_delivery_chain.mjs` / `_verify_staff_tier.mjs` 同一办法。
 * 要看"真实来源 IP"下的行为就设 `ROLLBACK_VERIFY_XFF=direct`。
 */
const XFF = process.env.ROLLBACK_VERIFY_XFF === 'direct'
  ? ''
  : (process.env.ROLLBACK_VERIFY_XFF || `198.51.100.${Math.floor(Math.random() * 200) + 1}`);

/** 带来源 IP 的请求头（所有 fetch 都要经过它，否则限流仍会串桶）。 */
function headers(extra = {}) {
  return XFF ? { 'X-Forwarded-For': XFF, ...extra } : { ...extra };
}

const pool = new Pool({
  host: process.env.PGHOST, user: process.env.PGUSER, password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE ?? 'postgres',
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20_000,
});

async function tenantCount() {
  const r = await pool.query('select count(*)::int as n from public.tenants');
  return r.rows[0].n;
}
async function businessCount() {
  const r = await pool.query('select count(*)::int as n from public.businesses');
  return r.rows[0].n;
}

async function signup(email, password, name) {
  const r = await fetch(`${BASE}/api/auth/signup`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ email, password, business_name: name, industry: 'restaurant' }),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 允许非 JSON */ }
  return { status: r.status, body: json, raw: text.slice(0, 200) };
}

const results = [];
const record = (label, pass, detail) => results.push({ label, pass, detail });

// --- A. 已注册邮箱：必须 409 且零副作用 -------------------------------------
const before = await tenantCount();
const beforeBiz = await businessCount();
const a = await signup(EXISTING_EMAIL, 'Probe-pass-12345', 'Rollback Probe');
const after = await tenantCount();
const afterBiz = await businessCount();

record('A 已注册邮箱返回 409（不是 500）', a.status === 409, `status=${a.status} body=${a.raw}`);
record('A 提示可执行（告诉用户去登录）', /sign in|already registered/i.test(a.raw), a.raw);
record(
  'A 零副作用：租户数不变',
  after === before,
  `before=${before} after=${after}${after === before ? '' : '  ← 又建了孤儿租户'}`,
);
record(
  'A 零副作用：业务数不变',
  afterBiz === beforeBiz,
  `before=${beforeBiz} after=${afterBiz}`,
);

// --- B. 全新邮箱：必须 201 且 +1 --------------------------------------------
const fresh = `rollback-${Date.now()}@example.invalid`;
const b = await signup(fresh, 'Probe-pass-12345', 'Rollback Fresh');
const afterB = await tenantCount();
record('B 全新邮箱注册成功 201', b.status === 201, `status=${b.status} body=${b.raw}`);
record('B 租户数 +1（正常路径未被改坏）', afterB === after + 1, `before=${after} after=${afterB}`);

// --- C. 新账号能登录 ---------------------------------------------------------
let c = { status: 0, raw: '' };
try {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ email: fresh, password: 'Probe-pass-12345' }),
  });
  c = { status: r.status, raw: (await r.text()).slice(0, 160) };
} catch (e) { c = { status: 0, raw: e.message }; }
record('C 新账号可登录 200', c.status === 200, `status=${c.status} body=${c.raw}`);

// --- 报告 --------------------------------------------------------------------
console.log(`\nbase = ${BASE}\n`);
let failed = 0;
for (const r of results) {
  console.log(`  ${r.pass ? '[ok]  ' : '[FAIL]'} ${r.label}\n         ${r.detail}`);
  if (!r.pass) failed += 1;
}
console.log('\n' + '='.repeat(78));
if (failed === 0) {
  console.log(`注册回滚验证通过：${results.length}/${results.length}`);
  console.log('关键点：已注册邮箱返回 409 且库里没有多出任何租户/业务。');
} else {
  console.log(`${failed}/${results.length} 项失败`);
}
console.log(`\n提示：B 段建了测试租户「Rollback Fresh」(${fresh})，清理：`);
console.log('  npx tsx scripts/_cleanup_probe_tenants.mts   （需先把名字加进白名单）');

await pool.end();
process.exit(failed === 0 ? 0 : 1);
