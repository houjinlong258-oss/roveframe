/**
 * 只读审计脚本：对运行中的服务发**匿名**请求，验证边界是否真的拦得住。
 *
 * 安全性：所有请求都不带会话 cookie；写方法一律发**故意损坏的 JSON**（"{"），
 * 让 handler 在 `request.json()` 处就失败，从而不会真的写库。
 * /api/admin/* 是重点：src/proxy.ts:58 显式跳过这一前缀的鉴权，
 * 边界保护完全依赖 handler 内的 requirePlatformAdmin。
 *
 * 阳性对照：同时请求 3 个**确实匿名可达**的公开路由。若探针连这些都报 401，
 * 说明它测的不是"守卫"而是"探针自己坏了"。
 *
 * 用法：node scripts/_audit_unauth_probe.mjs [base]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:5067';
const ROOT = process.cwd();
const API_DIR = join(ROOT, 'src', 'app', 'api');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name === 'route.ts') out.push(full);
  }
  return out;
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const routes = walk(API_DIR).map((file) => {
  const src = readFileSync(file, 'utf8');
  const urlPath = '/api/' + relative(API_DIR, file).split(sep).slice(0, -1).join('/');
  const methods = METHODS.filter((m) =>
    new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${m}\\b`).test(src),
  );
  return { urlPath, methods };
});

function concrete(path) {
  return path.replace(/\[[^\]]+\]/g, '00000000-0000-0000-0000-000000000001');
}

const rnd = () => Math.random().toString(16).slice(2, 10);

async function probe(method, urlPath) {
  const url = BASE + concrete(urlPath);
  const headers = {
    'content-type': 'application/json',
    'x-forwarded-for': `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
    'x-request-id': `audit-${rnd()}`,
  };
  const init = { method, headers, redirect: 'manual' };
  if (method !== 'GET') init.body = '{';
  try {
    const res = await fetch(url, init);
    const text = await res.text().catch(() => '');
    return { status: res.status, body: text.slice(0, 140).replace(/\s+/g, ' ') };
  } catch (e) {
    return { status: -1, body: String(e && e.message ? e.message : e) };
  }
}

const rows = [];
for (const r of routes) {
  if (!r.urlPath.startsWith('/api/admin')) continue;
  for (const m of r.methods) {
    const res = await probe(m, r.urlPath);
    rows.push({ urlPath: r.urlPath, method: m, ...res });
  }
}

console.log(`=== /api/admin/* anonymous probe (${rows.length} handlers) ===`);
for (const r of rows) {
  const verdict = r.status === 401 || r.status === 403 ? 'BLOCKED' : 'NOT-BLOCKED';
  console.log(`${verdict} ${String(r.status).padStart(4)} ${r.method.padEnd(6)} ${r.urlPath} :: ${r.body}`);
}

// ---- 阳性对照：这几个必须匿名可达（否则探针本身失效） ----
console.log('=== positive control: public routes MUST be reachable anonymously ===');
const controls = [
  ['GET', '/api/health'],
  ['GET', '/api/store/menu'],
  ['GET', '/api/site/config'],
];
let controlOk = 0;
for (const [m, p] of controls) {
  const res = await probe(m, p);
  const reachable = res.status > 0 && res.status !== 401 && res.status !== 403;
  if (reachable) controlOk++;
  console.log(`${reachable ? 'REACHABLE' : 'BLOCKED(!)'} ${String(res.status).padStart(4)} ${m} ${p} :: ${res.body}`);
}
console.log(`positive_control_reachable=${controlOk}/${controls.length}`);

// ---- 会话边界抽查：这些没有会话就必须 401 ----
console.log('=== session boundary sample (must be 401 without a session cookie) ===');
const sample = [
  ['GET', '/api/settings'],
  ['POST', '/api/settings/wipe'],
  ['POST', '/api/agent/chat'],
  ['POST', '/api/payments/checkout'],
  ['GET', '/api/metrics'],
  ['POST', '/api/business/products'],
  ['DELETE', '/api/store/qr-codes'],
  ['GET', '/api/artifacts'],
  ['POST', '/api/team/invite'],
  ['POST', '/api/coding-agent/apply'],
];
let blocked = 0;
for (const [m, p] of sample) {
  const res = await probe(m, p);
  const ok = res.status === 401 || res.status === 403;
  if (ok) blocked++;
  console.log(`${ok ? 'BLOCKED' : 'NOT-BLOCKED'} ${String(res.status).padStart(4)} ${m.padEnd(6)} ${p} :: ${res.body}`);
}
console.log(`session_boundary_blocked=${blocked}/${sample.length}`);
