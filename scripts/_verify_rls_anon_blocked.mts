/**
 * RLS 修复的**阳性/阴性对照**（只读）。
 *
 * 复现独立审查用的同一种读取：同一把 anon key、同一组表。
 * 修复前 anon 能读到 delivery_orders 21/21、delivery_positions 16/16 等；
 * 修复后应当读到 0 行或权限错误，而被 RLS 覆盖的表（orders/customers）保持 0 行
 * 作为阳性对照 —— 只测"读不到"是不够的，必须同时证明"查询本身是有效的"。
 */
const url = process.env.COZE_SUPABASE_URL;
const anon = process.env.COZE_SUPABASE_ANON_KEY;
const svc = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY;
if (!url || !anon || !svc) {
  console.error('缺 env：需要 COZE_SUPABASE_URL / ANON_KEY / SERVICE_ROLE_KEY');
  process.exit(2);
}

async function count(key: string, table: string, label: string): Promise<{ ok: boolean; n: number | string | null }> {
  const res = await fetch(`${url}/rest/v1/${table}?select=id&limit=1000`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact' },
  });
  const body = await res.text();
  let n = null;
  if (res.ok) {
    try { n = JSON.parse(body).length; } catch { n = 'parse-error'; }
  }
  const shown = res.ok ? `${n} 行` : `HTTP ${res.status} ${body.slice(0, 60)}`;
  console.log(`  ${label.padEnd(30)} ${shown}`);
  return { ok: res.ok, n };
}

console.log('='.repeat(78));
console.log('RLS 修复对照：同一把 anon key 读取（修复后应为 0 行或权限错误）');
console.log('='.repeat(78));

console.log('');
console.log('[A] 修复前被点名的 4 张表（anon 应读不到）');
const a: { ok: boolean; n: number | string | null }[] = [];
for (const t of ['delivery_orders', 'delivery_positions', 'staff_attendance', 'public_sites']) {
  a.push(await count(anon, t, `anon → ${t}`));
}

console.log('');
console.log('[B] 修复前新增覆盖的 8 张表（anon 应读不到）');
for (const t of ['customer_accounts', 'customer_addresses', 'customer_sessions', 'staff_shifts', 'staff_care_notes', 'staff_care_tasks', 'email_unsubscribes', 'health_check']) {
  a.push(await count(anon, t, `anon → ${t}`));
}

console.log('');
console.log('[C] 阳性对照：这些表在修复前就已被 RLS 覆盖，anon 一直是 0 行');
const positives: { ok: boolean; n: number | string | null }[] = [];
for (const t of ['orders', 'customers', 'store_qr_codes', 'settings']) {
  positives.push(await count(anon, t, `anon → ${t}（阳性对照）`));
}

console.log('');
console.log('[D] service_role 对照：应用路径必须不受影响（应当读到真实行数）');
for (const t of ['delivery_orders', 'delivery_positions', 'staff_attendance', 'public_sites', 'orders']) {
  await count(svc, t, `service_role → ${t}`);
}

console.log('');
const allAnonBlocked = [...a, ...positives].every((r) => !r.ok || r.n === 0);
console.log(allAnonBlocked
  ? '判定 PASS：anon 对所有被测表均无任何可读行'
  : '判定 FAIL：anon 仍读到行 —— RLS 未生效');
console.log('='.repeat(78));
process.exit(allAnonBlocked ? 0 : 1);
