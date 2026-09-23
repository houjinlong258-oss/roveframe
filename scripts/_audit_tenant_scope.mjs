/**
 * 只读审计脚本：**应用层租户隔离面**的形态扫描。
 *
 * 背景：服务端一律用 service_role，而 service_role **绕过 RLS**。
 * 因此租户隔离在生产路径上完全由应用层承担 —— 数据层不再是兜底。
 * 那么"哪些读操作没有 business_id 收敛"就是真正的问题。
 *
 * 做法：列出所有非公开路由文件，找出引用了 BUSINESS_SCOPED_TABLES 里的表、
 * 却在整份文件里**一次都没出现 `business_id`** 的那些。
 * 这是启发式（会有假阳性：可能通过 scopedTable/tenant-db 收敛），
 * 所以它输出的是"待人工核对的候选"，不是结论。
 *
 * 阴性对照：把 tenant-db.ts 的表清单换成一个真实存在但不该被扫的表名时，
 * 结果必须随之改变（用 --table <name> 指定单表来验证扫描是活的）。
 *
 * 用法：node scripts/_audit_tenant_scope.mjs [--table <name>]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const API_DIR = join(ROOT, 'src', 'app', 'api');

const tenantDb = readFileSync(join(ROOT, 'src', 'lib', 'tenant-db.ts'), 'utf8');
const start = tenantDb.indexOf('BUSINESS_SCOPED_TABLES');
const block = tenantDb.slice(start, tenantDb.indexOf(']);', start));
let SCOPED = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

const tArg = process.argv.indexOf('--table');
if (tArg >= 0) SCOPED = [process.argv[tArg + 1]];
console.log(`scoped tables considered: ${SCOPED.length}`);
if (!process.env.RF_AUDIT_QUIET) console.log(`  ${SCOPED.join(', ')}`);

// 公开路由（proxy 放行）也要看：它们没有会话，更需要服务端收敛
const authGuard = readFileSync(join(ROOT, 'src', 'lib', 'auth-guard.ts'), 'utf8');
const pubBlock = authGuard.slice(authGuard.indexOf('PUBLIC_API_PREFIXES'), authGuard.indexOf('export function isPublicApiPath'));
const PUBLIC_PREFIXES = [...pubBlock.matchAll(/'(\/api[^']*)'/g)].map((m) => m[1]);
const isPublic = (p) => PUBLIC_PREFIXES.some((pre) => p === pre || p.startsWith(pre + '/'));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name === 'route.ts') out.push(full);
  }
  return out;
}

const candidates = [];
const scopedOk = [];
for (const file of walk(API_DIR)) {
  const src = readFileSync(file, 'utf8');
  const urlPath = '/api/' + relative(API_DIR, file).split(sep).slice(0, -1).join('/');
  const usedTables = SCOPED.filter((t) => new RegExp(`from\\(['"]${t}['"]\\)`).test(src));
  if (usedTables.length === 0) continue;
  const hasBusinessFilter = /business_id|scopedTable|insertWithScope|updateWithScope|requireBusinessContext|protectBusinessMutation|protectTenantMutation/.test(src);
  const row = { urlPath, usedTables, publicRoute: isPublic(urlPath) };
  if (hasBusinessFilter) scopedOk.push(row);
  else candidates.push(row);
}

console.log(`\nROUTES_USING_SCOPED_TABLES=${candidates.length + scopedOk.length}`);
console.log(`  with a business scoping marker = ${scopedOk.length}`);
console.log(`  WITHOUT any scoping marker     = ${candidates.length}`);
for (const c of candidates) {
  console.log(`  [${c.publicRoute ? 'PUBLIC' : 'session'}] ${c.urlPath}  tables=${c.usedTables.join(',')}`);
}
