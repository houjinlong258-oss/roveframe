/**
 * 只读审计脚本：**按导出方法**（而不是按文件）判定守卫。
 *
 * 为什么需要它：`_audit_route_guards.mjs` 是文件级 grep —— 一个文件里
 * GET 有守卫、DELETE 没有守卫，文件级结论是"有守卫"。对 `/api/admin/*`
 * 尤其危险，因为 proxy 显式**不**鉴权这一前缀（src/proxy.ts:58），
 * 边界保护完全依赖 handler 内那句 requirePlatformAdmin。
 *
 * 用法：node scripts/_audit_method_guards.mjs [--root <dir>] [--only admin|public|all]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const rootArg = process.argv.indexOf('--root');
const ROOT = rootArg >= 0 ? process.argv[rootArg + 1] : process.cwd();
const onlyArg = process.argv.indexOf('--only');
const ONLY = onlyArg >= 0 ? process.argv[onlyArg + 1] : 'all';
const API_DIR = join(ROOT, 'src', 'app', 'api');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name === 'route.ts') out.push(full);
  }
  return out;
}

const authGuardSrc = readFileSync(join(ROOT, 'src', 'lib', 'auth-guard.ts'), 'utf8');
const publicBlock = authGuardSrc.slice(
  authGuardSrc.indexOf('PUBLIC_API_PREFIXES'),
  authGuardSrc.indexOf('export function isPublicApiPath'),
);
const PUBLIC_PREFIXES = [...publicBlock.matchAll(/'(\/api[^']*)'/g)].map((m) => m[1]);
const isPublic = (p) => PUBLIC_PREFIXES.some((pre) => p === pre || p.startsWith(pre + '/'));

const GUARDS = [
  ['platformAdmin', /requirePlatformAdmin\s*\(|adminHandler\s*\(|resolvePlatformAdmin\s*\(/],
  ['withAuth', /\bwithAuth\s*\(/],
  ['mutationGuard', /protectBusinessMutation|protectTenantMutation|runBusinessMutation|runTenantMutation/],
  ['tenantPermission', /requirePermission\s*\(|requireBusinessContext\s*\(|getTenantContext\s*\(/],
  ['sessionResolve', /resolveRequestUser\s*\(|resolveUserByRequest\s*\(/],
  ['customerSession', /resolveCustomerSession\s*\(/],
  ['staffSession', /staffRequestContext\s*\(|resolveStaffForUser\s*\(/],
  ['staffFeature', /requireStaffFeature\s*\(/],
  ['serviceSharedKey', /ROVEAGENT_API_KEY|x-roveagent-key|X-RoveAgent-Key|APPROVAL_SECRET|verifySignature|createHmac|verifyHmac|timingSafeEqual|verifySquareSignature|verifyStripeSignature|resolvePublicStore|resolvePublicSite|getDeviceIdFromRequest/],
  ['oauthState', /verifySquareOAuthState\s*\(/],
  ['tokenIdentity', /resolveUserByToken|verifyUnsubscribeToken|resolveUnsubscribeToken|unsubscribeToken|staffToken|tableToken|qrToken|resolveTableToken|resolveStaffToken/i],
  ['rateLimit', /enforceRateLimit|checkRateLimit|rateLimit|consumeRateLimit/],
];

/**
 * 从 `export ...` 起点取函数体。
 *
 * 必须先跳过**参数表**再找函数体的第一个 `{`：形如
 *   `export async function GET(request: Request, { params }: Params) {`
 * 的参数里有解构大括号，直接取第一个 `{` 得到的是 `{ params }`，
 * 于是守卫调用落在切片之外，一个**有守卫生的** route 会被误报成无守卫
 * （本脚本第一版就是这样把 /api/admin/tenants/[id] 误报出来的）。
 */
function extractBodies(src) {
  const out = [];
  const re = /export\s+(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*[:=])/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1] || m[2];
    // 1) 跳到参数表结束：从第一个 '(' 起按圆括号配平
    const parenStart = src.indexOf('(', m.index);
    let parenEnd = -1;
    if (parenStart >= 0) {
      let pd = 0;
      for (let i = parenStart; i < src.length; i++) {
        if (src[i] === '(') pd++;
        else if (src[i] === ')') {
          pd--;
          if (pd === 0) { parenEnd = i; break; }
        }
      }
    }
    // 2) 参数表之后第一个 '{' 才是函数体
    const braceStart = src.indexOf('{', parenEnd >= 0 ? parenEnd : m.index);
    if (braceStart < 0) continue;
    let depth = 0;
    let i = braceStart;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push({ name, body: src.slice(braceStart, i + 1), line: src.slice(0, m.index).split('\n').length });
  }
  return out;
}

const rows = [];
for (const file of walk(API_DIR)) {
  const src = readFileSync(file, 'utf8');
  const urlPath = '/api/' + relative(API_DIR, file).split(sep).slice(0, -1).join('/');
  const pub = isPublic(urlPath);
  const adm = urlPath.startsWith('/api/admin');
  if (ONLY === 'admin' && !adm) continue;
  if (ONLY === 'public' && !pub) continue;
  for (const { name, body, line } of extractBodies(src)) {
    if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(name)) continue;
    const flags = GUARDS.filter(([, re]) => re.test(body)).map(([n]) => n);
    rows.push({ urlPath, method: name, line, flags, pub, adm });
  }
}

console.log(`METHOD_HANDLERS=${rows.length}`);
const adminRows = rows.filter((r) => r.adm);
const nakedAdmin = adminRows.filter((r) => !r.flags.includes('platformAdmin'));
console.log(`ADMIN_HANDLERS=${adminRows.length} WITHOUT_PLATFORM_GUARD_IN_BODY=${nakedAdmin.length}`);
for (const r of nakedAdmin) console.log(`  ${r.urlPath} ${r.method} (${r.line}) flags=[${r.flags.join(',')}]`);

const pubWrites = rows.filter((r) => r.pub && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method));
console.log(`PUBLIC_WRITE_HANDLERS=${pubWrites.length}`);
for (const r of pubWrites) {
  const unguarded = r.flags.length === 0;
  console.log(`  ${unguarded ? 'NO-MARKER ' : '          '}${r.urlPath} ${r.method} (${r.line}) flags=[${r.flags.join(',')}]`);
}

const allNaked = rows.filter((r) => r.flags.length === 0);
console.log(`HANDLERS_WITH_NO_MARKER_AT_ALL=${allNaked.length}`);
for (const r of allNaked) console.log(`  ${r.urlPath} ${r.method} pub=${r.pub} adm=${r.adm}`);
