/**
 * 只读审计脚本：把 src/app/api 下每个 route.ts 按"守卫形态"分类。
 *
 * 这一轮的目的不是证明"有守卫"，而是找出**没有任何守卫标记**的路由，
 * 并区分它们靠什么拦住匿名请求（proxy 网络边界 / 公开白名单 / 路由内守卫）。
 *
 * 用法：node scripts/_audit_route_guards.mjs [--json]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// --root 用于阴性对照：把同一套分类器跑在一个**合成的** API 树上，
// 证明它真的能把"无守卫"判成无守卫，而不是恒返回同一份名单。
const rootArg = process.argv.indexOf('--root');
const ROOT = rootArg >= 0 ? process.argv[rootArg + 1] : process.cwd();
const API_DIR = join(ROOT, 'src', 'app', 'api');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name === 'route.ts') out.push(full);
  }
  return out;
}

// 从 auth-guard.ts 解析公开白名单，避免在这里复制一份会漂移的列表
const authGuardSrc = readFileSync(join(ROOT, 'src', 'lib', 'auth-guard.ts'), 'utf8');
const publicBlock = authGuardSrc.slice(
  authGuardSrc.indexOf('PUBLIC_API_PREFIXES'),
  authGuardSrc.indexOf('export function isPublicApiPath'),
);
const PUBLIC_PREFIXES = [...publicBlock.matchAll(/'(\/api[^']*)'/g)].map((m) => m[1]);

const isPublic = (p) => PUBLIC_PREFIXES.some((pre) => p === pre || p.startsWith(pre + '/'));

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

const rules = [
  ['platformAdmin', /requirePlatformAdmin\s*\(|adminHandler\s*\(/],
  ['withAuth', /\bwithAuth\s*\(/],
  ['mutationGuard', /protectBusinessMutation|protectTenantMutation|runBusinessMutation|runTenantMutation/],
  ['tenantPermission', /requirePermission\s*\(|requireBusinessContext\s*\(|getTenantContext\s*\(/],
  ['authContextFastPath', /getAuthContext\s*\(/],
  ['resolveRequestUser', /resolveRequestUser\s*\(|resolveUserByRequest\s*\(/],
  ['customerSession', /resolveCustomerSession\s*\(/],
  ['staffSession', /staffRequestContext\s*\(|resolveStaffForUser\s*\(/],
  ['oauthState', /verifySquareOAuthState\s*\(/],
  ['staffFeature', /requireStaffFeature\s*\(/],
  ['serviceSharedKey', /ROVEAGENT_API_KEY|x-roveagent-key|X-RoveAgent-Key|APPROVAL_SECRET|verifySignature|createHmac/],
  ['tokenIdentity', /resolveUserByToken|verifyUnsubscribeToken|resolveStaffToken|tableToken|qr_token/i],
];

const routes = walk(API_DIR).map((file) => {
  const src = readFileSync(file, 'utf8');
  const urlPath = '/api/' + relative(API_DIR, file).split(sep).slice(0, -1).join('/');
  const methods = METHODS.filter((m) =>
    new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${m}\\b`).test(src),
  );
  const flags = rules.filter(([, re]) => re.test(src)).map(([n]) => n);
  return {
    urlPath,
    file: relative(ROOT, file).split(sep).join('/'),
    methods,
    flags,
    publicListed: isPublic(urlPath),
    adminPath: urlPath.startsWith('/api/admin'),
    lines: src.split('\n').length,
  };
});

routes.sort((a, b) => a.urlPath.localeCompare(b.urlPath));

const unguarded = routes.filter(
  (r) => r.flags.length === 0 && !r.publicListed && !r.adminPath,
);
const adminNoGuard = routes.filter((r) => r.adminPath && !r.flags.includes('platformAdmin'));
const adminRoutes = routes.filter((r) => r.adminPath);
const writeMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
const unguardedWrites = unguarded.filter((r) => r.methods.some((m) => writeMethods.includes(m)));

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ routes, unguarded, adminNoGuard }, null, 2));
} else {
  console.log(`ROUTES=${routes.length}`);
  console.log(`PUBLIC_LISTED=${routes.filter((r) => r.publicListed).length}`);
  console.log(`ADMIN_PATHS=${adminRoutes.length}`);
  console.log(`ADMIN_WITHOUT_PLATFORM_GUARD=${adminNoGuard.length} (${adminNoGuard.map((r) => r.urlPath).join(', ')})`);
  console.log(`NO_IN_HANDLER_MARKER_NON_PUBLIC_NON_ADMIN=${unguarded.length}`);
  console.log('--- those, with their exported methods ---');
  for (const r of unguarded) console.log(`${r.urlPath}  [${r.methods.join(',')}]  lines=${r.lines}`);
  console.log(`--- of which accept a write method: ${unguardedWrites.length} ---`);
  for (const r of unguardedWrites) console.log(`${r.urlPath}  [${r.methods.join(',')}]`);
  console.log('--- flag histogram (how many routes use each marker) ---');
  for (const [name] of rules) {
    console.log(`${name}=${routes.filter((r) => r.flags.includes(name)).length}`);
  }
}
