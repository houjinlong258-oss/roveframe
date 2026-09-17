/**
 * Phase 15 — 用真实 HTTP 证明"已连接"语义不再夸大（会写测试数据）。
 *
 * ## 证明什么
 *
 * 旧行为：给任意 provider 保存配置即写 `status: 'connected'`，
 * 而 `/api/integrations/[provider]/sync` 只支持 square ——
 * 于是 ERPNext 在 UI 上显示"已连接"，数据却永远不会到达。
 *
 * 断言（任一不成立即失败）：
 *   1. 保存 ERPNext 配置后，返回列表里它的 status **不是** `connected`；
 *   2. 它带 `syncable: false`；
 *   3. 它带 `capabilityNotice`（说明数据不会同步）；
 *   4. 它没有 `last_sync_at`（不再伪造"刚刚同步过"）；
 *   5. 调它的 sync 端点返回 400 且说明未实现。
 *
 * 跑完请清理：npx tsx scripts/_cleanup_test_residue.mts --apply
 */
const BASE = `http://127.0.0.1:${process.env.WEB_PORT || '5055'}`;
const CLIENT_IP = '203.0.113.41';

interface Row { [k: string]: unknown }

async function main(): Promise<number> {
  const stamp = Date.now();
  const email = `e2e-erp-${stamp}@example.com`;
  const password = `Rove!${stamp}Aa9`;

  console.log('='.repeat(78));
  console.log('Phase 15 — ERPNext "已连接"语义的真实 HTTP 验证');
  console.log('='.repeat(78));

  const signup = await fetch(`${BASE}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': CLIENT_IP },
    body: JSON.stringify({
      email, password, business_name: `ERP probe ${stamp}`, industry: 'restaurant',
      language: 'en', currency: 'USD',
    }),
  });
  const cookie = (signup.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  console.log(`注册: HTTP ${signup.status}`);
  if (signup.status !== 201) { console.log('注册失败'); return 2; }

  const post = (path: string, body: unknown) => fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-forwarded-for': CLIENT_IP },
    body: JSON.stringify(body),
  });

  // 1) 保存 ERPNext 配置（这正是老板在设置页点"连接"时发生的事）
  const connect = await post('/api/integrations', {
    provider: 'erpnext',
    config: { url: 'https://erp.example.com', apiKey: 'k', apiSecret: 's' },
    syncScope: ['inventory'],
  });
  console.log(`保存 ERPNext 配置: HTTP ${connect.status}`);

  // 2) 读回列表
  const listRes = await fetch(`${BASE}/api/integrations`, {
    headers: { cookie, 'x-forwarded-for': CLIENT_IP },
  });
  const listBody = (await listRes.json()) as { integrations?: Row[] };
  const erp = (listBody.integrations ?? []).find((i) => i.provider === 'erpnext');
  console.log('');
  console.log(`读回 ERPNext 记录: ${erp ? JSON.stringify(erp) : '(未找到)'}`);
  console.log('');

  const checks: Array<[string, boolean, string]> = [];
  if (!erp) {
    checks.push(['ERPNext 记录存在', false, '列表里没有 erpnext']);
  } else {
    checks.push(['status 不是 connected', erp.status !== 'connected', `status=${String(erp.status)}`]);
    checks.push(['syncable 为 false', erp.syncable === false, `syncable=${String(erp.syncable)}`]);
    checks.push(['带 capabilityNotice', Boolean(erp.capabilityNotice), `notice=${String(erp.capabilityNotice).slice(0, 60)}`]);
    checks.push(['未伪造 last_sync_at', erp.last_sync_at === null || erp.last_sync_at === undefined, `last_sync_at=${String(erp.last_sync_at)}`]);
  }

  // 3) 同步端点必须明确说未实现
  const syncRes = await post('/api/integrations/erpnext/sync', {});
  const syncBody = (await syncRes.json().catch(() => ({}))) as Row;
  console.log(`sync 端点: HTTP ${syncRes.status} body=${JSON.stringify(syncBody).slice(0, 180)}`);
  checks.push([
    'sync 端点拒绝并说明未实现',
    syncRes.status === 400 && /not implemented/i.test(JSON.stringify(syncBody)),
    `HTTP ${syncRes.status}`,
  ]);

  console.log('');
  console.log('='.repeat(78));
  let failed = 0;
  for (const [name, ok, detail] of checks) {
    if (!ok) failed += 1;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} — ${detail}`);
  }
  console.log('');
  console.log(failed === 0
    ? '结论: 不可同步的集成不再声称"已连接"，且明确说明数据不会同步。'
    : `结论: ${failed} 项未通过 —— 误导性状态仍然存在。`);
  console.log('='.repeat(78));
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 800).unref(); })
  .catch((e: unknown) => { console.error('崩溃:', e); process.exitCode = 2; });
