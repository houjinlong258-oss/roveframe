/**
 * 员工端全链路真实验证（真实 HTTP + 真实会话 + 真实数据库）。
 *
 * ## 这一步填的是哪个空白
 *
 * 员工端的代码、接口、守卫测试全都到位，但 `staff` 是 0 行 —— 于是任何真实会话
 * 都在 `/api/staff/me` 撞 409，**没有任何人能登进去**。结果是所有断言只能停在
 * "源码级"：接口长什么样、参数对不对，都是读代码得出的。
 *
 * 现在库里有了一个真账号 + 真档案 + 3 条排班 + 2 条考勤，于是可以打真请求、
 * 带真会话，验的是"数据能不能流到员工面前"，而不是"代码看起来对不对"。
 *
 * ## 关键点
 *
 * 会话 cookie 是真登录拿到的（`rf_session`，见 src/lib/auth.ts 的
 * SESSION_COOKIE_NAME），不是伪造的 JWT —— 伪造的 JWT 只能证明处理器逻辑，
 * 证明不了登录链路。
 *
 * 用法：
 *   node scripts/_verify_staff_tier.mjs <baseUrl> <email> <password>
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:5067';
const EMAIL = process.argv[3] ?? 'staff.demo@roveframe.local';
const PASSWORD = process.argv[4] ?? 'Staff-demo-2026';

const results = [];
const record = (label, pass, detail) => results.push({ label, pass, detail });

/**
 * 本脚本请求使用的来源 IP（`X-Forwarded-For`）。
 *
 * 为什么需要它：登录限流按 `auth:login:ip:<getClientIp()>` 计数，而 `getClientIp`
 * （src/lib/rate-limit.ts:176）先看 `x-forwarded-for`。本机直连时没有代理设置这个头，
 * 于是**所有**直连调用方共用同一个 IP 桶 —— 反复跑本脚本会把**正确密码**的登录
 * 一起锁进 429（实测：本脚本第一版就是这么失败的，表现为"登录 200 且拿到会话 cookie"
 * 这一条变红，看起来像登录坏了，实际是限流）。
 *
 * 与 `_verify_delivery_chain.mjs` 用同一个办法：每次运行取一个独立的、
 * 保留给文档用的测试网段地址。要看"真实来源 IP"下的行为就设
 * `STAFF_VERIFY_XFF=direct`（不发这个头，落回 `unknown` 桶）。
 */
const XFF = process.env.STAFF_VERIFY_XFF === 'direct'
  ? ''
  : (process.env.STAFF_VERIFY_XFF || `198.51.100.${Math.floor(Math.random() * 200) + 1}`);

/** 从 Set-Cookie 里取会话 cookie，后续请求带上 —— 等价于浏览器的 cookie jar。 */
let cookie = '';
function captureCookie(response) {
  const raw = response.headers.getSetCookie?.() ?? [];
  for (const line of raw) {
    const pair = line.split(';')[0];
    if (pair.includes('=')) cookie = pair;
  }
}

async function call(path, init = {}) {
  const headers = { Accept: 'application/json', ...(init.headers ?? {}) };
  if (XFF) headers['X-Forwarded-For'] = XFF;
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${BASE}${path}`, { redirect: 'manual', ...init, headers });
  captureCookie(response);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 允许非 JSON */ }
  return { status: response.status, json, text, headers: response.headers };
}

// --- 1) 真实登录 -------------------------------------------------------------
const login = await call('/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
record('登录 200 且拿到会话 cookie', login.status === 200 && cookie.length > 0,
  `status=${login.status} cookie=${cookie ? cookie.split('=')[0] : '(无)'}`);
record('登录返回的角色是 staff', login.json?.role === 'staff', `role=${login.json?.role}`);

// --- 2) /api/staff/me：此前对一切真实会话都 409 -------------------------------
const me = await call('/api/staff/me');
record('/api/staff/me 200（不再是 409）', me.status === 200, `status=${me.status} body=${me.text.slice(0, 120)}`);
record('返回真实姓名', typeof me.json?.staff?.name === 'string' && me.json.staff.name.length > 0,
  `name=${JSON.stringify(me.json?.staff?.name)}`);
record('返回岗位（此前是空 / 取错列）', typeof me.json?.staff?.position === 'string' && me.json.staff.position.length > 0,
  `position=${JSON.stringify(me.json?.staff?.position)}`);
record('返回入职日期（此前从未透传）', typeof me.json?.staff?.hired_at === 'string' && me.json.staff.hired_at.length > 0,
  `hired_at=${JSON.stringify(me.json?.staff?.hired_at)}`);
record('返回 privacy 偏好（此前缺失，导致开关误显示为关）',
  me.json?.preferences !== undefined && typeof me.json.preferences.personal_data_opt_in === 'boolean',
  `preferences=${JSON.stringify(me.json?.preferences)}`);

// --- 3) 排班与考勤：有真实内容 ------------------------------------------------
const shifts = await call('/api/staff/shifts');
record('我的排班返回 3 条', shifts.status === 200 && Array.isArray(shifts.json?.shifts) && shifts.json.shifts.length === 3,
  `status=${shifts.status} count=${shifts.json?.shifts?.length ?? 'n/a'}`);

const att = await call('/api/staff/attendance');
record('考勤历史返回 2 条且带时长',
  att.status === 200 && Array.isArray(att.json?.records) && att.json.records.length === 2
    && att.json.records.every((r) => typeof r.worked_minutes === 'number'),
  `status=${att.status} count=${att.json?.records?.length ?? 'n/a'} minutes=${JSON.stringify((att.json?.records ?? []).map((r) => r.worked_minutes))}`);

// --- 4) 打卡：写路径 ----------------------------------------------------------
const clock = await call('/api/staff/attendance', { method: 'POST' });
record('打卡 200 且方向由服务端判定', clock.status === 200 && ['clock_in', 'clock_out'].includes(clock.json?.action),
  `status=${clock.status} action=${JSON.stringify(clock.json?.action)}`);

// --- 5) 数据导出：隐私义务的实际形态 ------------------------------------------
const exp = await call('/api/staff/export');
const disposition = exp.headers.get('content-disposition') ?? '';
record('导出 200', exp.status === 200, `status=${exp.status} body=${exp.text.slice(0, 100)}`);
record('导出带 Content-Disposition（真的是下载）', /attachment/i.test(disposition), `header=${JSON.stringify(disposition)}`);
record('导出含本人档案 + 排班 + 考勤',
  exp.json?.staff?.id !== undefined && Array.isArray(exp.json?.shifts) && Array.isArray(exp.json?.attendance),
  `keys=${Object.keys(exp.json ?? {}).join(',')}`);
record('导出不可被中间层缓存', /no-store/i.test(exp.headers.get('cache-control') ?? ''),
  `cache-control=${JSON.stringify(exp.headers.get('cache-control'))}`);

// --- 6) 负向对照：未登录必须被拒 ----------------------------------------------
const saved = cookie;
cookie = '';
const anon = await call('/api/staff/me');
record('负向对照：无会话时 /api/staff/me 返回 401', anon.status === 401, `status=${anon.status}`);
cookie = saved;

// --- 报告 --------------------------------------------------------------------
console.log(`\nbase = ${BASE}   as = ${EMAIL}\n`);
let failed = 0;
for (const r of results) {
  console.log(`  ${r.pass ? '[ok]  ' : '[FAIL]'} ${r.label}\n         ${r.detail}`);
  if (!r.pass) failed += 1;
}
console.log('\n' + '='.repeat(78));
if (failed === 0) {
  console.log(`员工端全链路验证通过：${results.length}/${results.length}`);
  console.log('用的是真实登录拿到的会话 cookie，不是伪造的 JWT。');
} else {
  console.log(`${failed}/${results.length} 项失败`);
}
process.exit(failed === 0 ? 0 : 1);
