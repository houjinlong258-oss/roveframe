/**
 * 只读审计脚本：延迟分布实测（只发 GET，不改数据）。
 *
 * 覆盖**公开面**（无需会话）：菜单读库、官网配置读库、SSR 首页、健康检查。
 * 需要会话的页面/接口（仪表盘、AI 对话）**不在此脚本内** —— 它们要登录，
 * 登录会写 auth.sessions，本轮不做写操作。因此本脚本的数字**不能**用来
 * 支撑"登录后的体验"结论。
 *
 * 用法：node scripts/_audit_latency.mjs [base] [iterations]
 */
const BASE = process.argv[2] || 'http://127.0.0.1:5067';
const N = Number(process.argv[3] || 25);

import { readFileSync } from 'node:fs';
const env = {};
for (const line of readFileSync('docker/deploy.env', 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(line);
  if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const B = env.COZE_SUPABASE_URL, A = env.COZE_SUPABASE_ANON_KEY;
const sites = await (await fetch(`${B}/rest/v1/public_sites?select=web_order_token&limit=1`, {
  headers: { apikey: A, authorization: `Bearer ${A}` },
})).json();
const token = sites?.[0]?.web_order_token;

const targets = [
  ['menu (DB read, public)', `/api/store/menu?token=${encodeURIComponent(token)}`],
  ['site config (DB read, public)', '/api/site/config?slug=demo-bistro'],
  ['health (DB + runtime probe)', '/api/health'],
  ['SSR landing page', '/en'],
];

function pct(sorted, p) {
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}

for (const [label, path] of targets) {
  const times = [];
  let codes = {};
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    try {
      const r = await fetch(BASE + path, { headers: { 'x-request-id': `audit-lat-${i}` } });
      await r.arrayBuffer();
      codes[r.status] = (codes[r.status] ?? 0) + 1;
    } catch (e) {
      codes['ERR'] = (codes['ERR'] ?? 0) + 1;
    }
    times.push(performance.now() - t0);
  }
  const s = [...times].sort((a, b) => a - b);
  console.log(
    `${label.padEnd(32)} n=${N} status=${JSON.stringify(codes)} p50=${pct(s, 50).toFixed(0)}ms p90=${pct(s, 90).toFixed(0)}ms p99=${pct(s, 99).toFixed(0)}ms max=${s[s.length - 1].toFixed(0)}ms`,
  );
}
