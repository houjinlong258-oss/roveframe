/**
 * Phase 18 真实 HTTP 验证。
 *
 * 这一层是本会话一直缺的那一层（代码存在 / 测试通过 / **真实调用** / 生产可用）。
 * 它打真实的网络请求，看真实的状态码 —— 不看源码推断。
 *
 * ## 每一行都配了负向对照
 *
 * 只报"200 了"没有意义：一个把所有路径都放行的 proxy 也能全 200。
 * 因此这里同时验证**该拒的必须拒**：
 *   · 公开路径必须能进 handler（不是 401），否则功能是死的
 *   · 受保护路径必须 401，否则是越权
 * 两个方向都对了，边界才算真的成立。
 *
 * 用法：node scripts/_verify_p18_http.mjs [baseUrl]
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:5067';

const results = [];

async function hit(label, path, init = {}) {
  const started = Date.now();
  try {
    const response = await fetch(`${BASE}${path}`, {
      redirect: 'manual',
      ...init,
    });
    const body = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* 非 JSON 是允许的（HTML/空） */ }
    results.push({
      label,
      path,
      status: response.status,
      ms: Date.now() - started,
      sample: (parsed?.error ? String(parsed.error) : body.slice(0, 60)).replace(/\s+/g, ' ').trim(),
    });
    return { status: response.status, body: parsed, headers: response.headers };
  } catch (error) {
    results.push({ label, path, status: 'ERR', ms: Date.now() - started, sample: error.message });
    return { status: 0, body: null, headers: null };
  }
}

async function waitReady(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.status) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

const ready = await waitReady();
if (!ready) {
  console.error('服务在 90 秒内没有响应');
  process.exit(1);
}

// --- 1) 健康检查：证明服务起来了、库连上了、迁移到位 -------------------------
const health = await hit('健康检查', '/api/health');

// --- 2) 公开路径必须"能进 handler"（不是 401）--------------------------------
// 用不存在的 slug/token，期望的是 400/404 —— 那说明请求穿过了边界到达了业务逻辑。
// 若返回 401，说明 PUBLIC_API_PREFIXES 漏了这一条，功能在真实运行时是死的。
const pubConfig = await hit('公开·站点配置（错的 slug）', '/api/site/config?slug=zzz-not-a-site');
const pubMenu = await hit('公开·菜单（错的 token）', '/api/store/menu?token=00000000000000000000000000000000');
const pubTrack = await hit('公开·配送轨迹（错的 id）', '/api/store/deliveries/zzz/track?token=00000000000000000000000000000000');
const pubRegister = await hit('公开·顾客注册（错的 slug）', '/api/customer/auth/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ slug: 'zzz-not-a-site', email: 'x@example.invalid', password: 'test-password-123' }),
});

// --- 3) 受保护路径必须 401（负向对照：边界不能放太宽）------------------------
const protTeam = await hit('受保护·店长外卖看板', '/api/team/delivery');
const protStaffMe = await hit('受保护·员工身份', '/api/staff/me');
const protWebsite = await hit('受保护·官网管理', '/api/website');
const protCustomerMe = await hit('受保护·顾客 me（未登录）', '/api/customer/me');

// --- 4) 页面路由 -------------------------------------------------------------
const pageStore = await hit('页面·顾客端 PWA', '/en/store');
const pageStaff = await hit('页面·员工端 PWA', '/en/staff');
const pageTeam = await hit('页面·老板端团队', '/en/team');
const pageSite = await hit('页面·公开官网（不存在）', '/en/site/zzz-not-a-site');

// ---------------------------------------------------------------------------
console.log(`\nbase = ${BASE}\n`);
console.log('  状态  耗时   标签 / 路径');
console.log('  ' + '-'.repeat(78));
for (const r of results) {
  const status = String(r.status).padStart(4);
  const ms = String(r.ms).padStart(6);
  console.log(`  ${status} ${ms}ms  ${r.label}`);
  console.log(`                ${r.path}${r.sample ? '   → ' + r.sample : ''}`);
}

// ---------------------------------------------------------------------------
// 判定：两个方向都要成立
// ---------------------------------------------------------------------------
const failures = [];

// 健康检查必须是 200 —— 若是 503，说明库/迁移/运行时有问题，后面的结论都不成立
if (health.status !== 200) failures.push(`/api/health 返回 ${health.status}（期望 200）—— 服务或数据库未就绪`);

// 公开路径：401 就是失败（边界挡住了本该公开的接口）
for (const [name, r] of [
  ['/api/site/config', pubConfig],
  ['/api/store/menu', pubMenu],
  ['/api/store/deliveries/:id/track', pubTrack],
  ['/api/customer/auth/register', pubRegister],
]) {
  if (r.status === 401) failures.push(`${name} 返回 401 —— 公开前缀缺失，真实运行时该功能不可达`);
  else if (r.status === 0) failures.push(`${name} 请求失败（网络层）`);
}

// 受保护路径：不是 401 就是失败（边界放太宽 = 越权）
for (const [name, r] of [
  ['/api/team/delivery', protTeam],
  ['/api/staff/me', protStaffMe],
  ['/api/website', protWebsite],
]) {
  if (r.status !== 401) failures.push(`${name} 返回 ${r.status}（期望 401）—— 受保护接口未要求会话`);
}

console.log('\n' + '='.repeat(80));
if (failures.length === 0) {
  console.log('真实 HTTP 验证通过：公开路径可达、受保护路径拒绝。');
} else {
  console.log(`失败 ${failures.length} 项：`);
  for (const f of failures) console.log('  ! ' + f);
}
process.exit(failures.length === 0 ? 0 : 1);
