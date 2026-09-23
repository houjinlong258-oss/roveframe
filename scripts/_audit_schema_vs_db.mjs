/**
 * 只读审计脚本：把 schema.ts 里声明的每一张表拿到**真实库**上问一遍存不存在。
 *
 * 为什么要自己量：
 *   · `/api/health` 的 missingCount 只覆盖 boot-check.ts 的 REQUIRED_TABLES（11 张）；
 *   · `pnpm validate:migrations` 是**纯文件**校验（schema.ts 的表名是否出现在某个
 *     migrate*.sql 里），它根本不连库。
 *   "52/52 张表都在"这句话只有在这两者之外单独取证才成立。
 *
 * 探针形态：用 service_role 发 `select=id&limit=1`（列投影，不是 head:true ——
 * head 探存在性会恒报存在）。阴性对照：凭空造一个表名，它必须报缺失。
 *
 * 用法：node scripts/_audit_schema_vs_db.mjs
 */
import { readFileSync } from 'node:fs';

const env = {};
for (const line of readFileSync('docker/deploy.env', 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(line);
  if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const B = env.COZE_SUPABASE_URL, S = env.COZE_SUPABASE_SERVICE_ROLE_KEY;
const headers = { apikey: S, authorization: `Bearer ${S}` };

const schema = readFileSync('src/storage/database/shared/schema.ts', 'utf8');
const tables = [...schema.matchAll(/pgTable\(\s*['"]([a-z0-9_]+)['"]/g)].map((m) => m[1]);
console.log(`schema.ts declares ${tables.length} tables`);

async function exists(table) {
  const r = await fetch(`${B}/rest/v1/${table}?select=id&limit=1`, { headers });
  const body = await r.text();
  let code = '';
  try { code = JSON.parse(body)?.code ?? ''; } catch { /* rows are fine */ }
  return { status: r.status, code };
}

const missing = [];
for (const t of tables) {
  const r = await exists(t);
  if (r.status >= 400 && r.code !== '42703') missing.push(`${t} (${r.status} ${r.code})`);
}
console.log(`TABLES_PRESENT=${tables.length - missing.length}/${tables.length}`);
console.log(`TABLES_MISSING=${missing.length} ${JSON.stringify(missing)}`);

// 阴性对照：不存在的表必须被报成缺失
const control = await exists('zzz_definitely_not_a_table_9f3a');
console.log(`negative_control(zzz_definitely_not_a_table_9f3a) -> status=${control.status} code=${control.code} (must be a 404/PGRST205-class miss)`);
