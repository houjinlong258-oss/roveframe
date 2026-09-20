/**
 * 造一个**真实可登录的员工**：auth 账号 + staff 档案 + 排班 + 考勤。
 *
 * ## 为什么需要它
 *
 * 员工端 PWA 的代码、接口、测试全都到位了，但 `staff` 表是 0 行 ——
 * 于是 `/api/staff/me` 对任何真实会话都返回 409，**没有任何人能登进员工端**。
 * 结果是排班、考勤、打卡、数据导出、关怀资源这些页面永远停在"结构完成"。
 *
 * ## 走的是产品自己的路径
 *
 * 账号用 GoTrue admin API 建（与 scripts/ensure-initial-user.ts 同一套），
 * 不是直接写 auth.users —— 那样密码哈希与 identity 行会不对，账号登不进去。
 *
 * ## 幂等
 *
 * 按 email 查已有账号，有就复用；staff 行按 user_id upsert。
 * --cleanup 精确删掉本脚本建的东西。
 *
 * 用法：
 *   $env:PGHOST=...; $env:PGUSER=...; $env:PGPASSWORD=...
 *   npx tsx scripts/_seed_demo_staff.mts
 *   npx tsx scripts/_seed_demo_staff.mts --cleanup
 */
import { Pool } from 'pg';

const TENANT = '00000000-0000-0000-0000-000000000000';
const BUSINESS = '00000000-0000-0000-0000-000000000001';
const EMAIL = 'staff.demo@roveframe.local';
const PASSWORD = 'Staff-demo-2026';
const NAME = 'Demo Staff';
const cleanup = process.argv.includes('--cleanup');

const SUPABASE_URL = process.env.COZE_SUPABASE_URL;
const SERVICE_KEY = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('缺 COZE_SUPABASE_URL / COZE_SUPABASE_SERVICE_ROLE_KEY（从 docker/deploy.env 加载）');
  process.exit(2);
}

const pool = new Pool({
  host: process.env.PGHOST, user: process.env.PGUSER, password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE ?? 'postgres',
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20_000,
});

/** GoTrue admin API：列出用户，按 email 找。返回 null 表示不存在。 */
async function findAuthUser(email: string): Promise<string | null> {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, {
    headers: { apikey: SERVICE_KEY!, Authorization: `Bearer ${SERVICE_KEY!}` },
  });
  if (!r.ok) throw new Error(`list users failed: HTTP ${r.status}`);
  const body = (await r.json()) as { users?: { id: string; email?: string }[] };
  return body.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase())?.id ?? null;
}

/** 建账号并注入 tenant/business claim —— 少了 claim，登录后鉴权链会拒绝。 */
async function createAuthUser(): Promise<string> {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY!, Authorization: `Bearer ${SERVICE_KEY!}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true, // 自托管无 SMTP，不自动确认则永远登不进去
      app_metadata: { tenant_id: TENANT, business_id: BUSINESS },
      user_metadata: { name: NAME },
    }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`create user failed: HTTP ${r.status} ${text.slice(0, 200)}`);
  const body = JSON.parse(text) as { id?: string };
  if (!body.id) throw new Error('create user returned no id');
  return body.id;
}

async function main() {
  if (cleanup) {
    const s = await pool.query('delete from public.staff_attendance where tenant_id=$1 and staff_id in (select id from public.staff where tenant_id=$1 and name=$2)', [TENANT, NAME]);
    const sh = await pool.query('delete from public.staff_shifts where tenant_id=$1 and staff_id in (select id from public.staff where tenant_id=$1 and name=$2)', [TENANT, NAME]);
    const st = await pool.query('delete from public.staff where tenant_id=$1 and business_id=$2 and name=$3', [TENANT, BUSINESS, NAME]);
    const uid = await findAuthUser(EMAIL);
    if (uid) {
      const d = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${uid}`, {
        method: 'DELETE',
        headers: { apikey: SERVICE_KEY!, Authorization: `Bearer ${SERVICE_KEY!}` },
      });
      console.log(`  auth 用户删除: HTTP ${d.status}`);
    }
    console.log(`  已清理：attendance ${s.rowCount} / shifts ${sh.rowCount} / staff ${st.rowCount}`);
    return;
  }

  // 1) auth 账号（已存在则复用，不重复建也不改密码）
  let userId = await findAuthUser(EMAIL);
  const reused = userId !== null;
  if (!userId) userId = await createAuthUser();

  // 2) staff 档案，关联到该账号
  //
  // ON CONFLICT 必须重复部分唯一索引的谓词：staff_user_id_key 是
  // "unique (user_id) where user_id is not null"，未关联账号的行不受它约束。
  // 只写 on conflict (user_id) 会报
  // "no unique or exclusion constraint matching the ON CONFLICT specification"。
  //
  // 注意：上面这句说明**不能**写进下面的 SQL 模板字符串里 ——
  // 里面一旦出现反引号，模板字符串会提前闭合。
  const staff = await pool.query<{ id: string }>(
    `insert into public.staff (tenant_id, business_id, user_id, name, role, position, phone, email, employment_type, hired_at, is_active)
     values ($1,$2,$3,$4,'staff','外场服务员','+1 555 0100',$5,'full_time','2024-03-15',true)
     on conflict (user_id) where user_id is not null
     do update set name = excluded.name, position = excluded.position
     returning id`,
    [TENANT, BUSINESS, userId, NAME, EMAIL],
  );
  const staffId = staff.rows[0].id;

  /**
   * 2.5) public.users 关联行 —— **必须有**。
   *
   * 少这一行的表现是登录直接 500 `resolve user failed: Cannot coerce the result
   * to a single JSON object`：`resolveUserByToken`（src/lib/auth.ts）要按 auth 用户 id
   * 去 public.users 取一行，取不到 `.single()` 就报这个错。
   *
   * 我第一次写这个脚本时就漏了它 —— 建了 auth 账号、建了 staff 档案，
   * 却没建把两者接到租户上的那一行。与注册路由原本的缺陷同类：
   * **建了凭据，没建归属**。而报错信息完全不提示"缺的是哪一行"。
   *
   * role 用 'staff'：RBAC 据此给出员工可见范围（不含营业额/客户/财务）。
   */
  await pool.query(
    `insert into public.users (id, tenant_id, business_id, email, name, role)
     values ($1,$2,$3,$4,$5,'staff')
     on conflict (id) do update set name = excluded.name, business_id = excluded.business_id`,
    [userId, TENANT, BUSINESS, EMAIL, NAME],
  );

  // 3) 未来三天排班 —— 让"我的排班"有真实内容
  await pool.query('delete from public.staff_shifts where staff_id = $1', [staffId]);
  for (let d = 0; d < 3; d += 1) {
    await pool.query(
      `insert into public.staff_shifts (tenant_id, business_id, staff_id, starts_at, ends_at, role, note)
       values ($1,$2,$3, (current_date + $4::int) + time '11:00', (current_date + $4::int) + time '19:00', '外场服务员', '')`,
      [TENANT, BUSINESS, staffId, d],
    );
  }

  // 4) 两条已闭合的考勤 —— 让"考勤历史"有内容（含工作时长）
  await pool.query('delete from public.staff_attendance where staff_id = $1', [staffId]);
  for (const [dayOffset, hours] of [[-1, 7.5], [-2, 8]] as const) {
    await pool.query(
      `insert into public.staff_attendance (tenant_id, business_id, staff_id, clock_in_at, clock_out_at, clock_in_source)
       values ($1,$2,$3, (current_date + $4::int) + time '11:00', (current_date + $4::int) + time '11:00' + ($5::text || ' hours')::interval, 'staff_pwa')`,
      [TENANT, BUSINESS, staffId, dayOffset, hours],
    );
  }

  console.log(JSON.stringify({
    email: EMAIL,
    password: reused ? '(已存在，未改密码)' : PASSWORD,
    authUserReused: reused,
    userId,
    staffId,
    shifts: 3,
    attendance: 2,
  }, null, 2));
}

main()
  .then(() => pool.end())
  .catch(async (e) => { console.error('[FAIL]', e.message); await pool.end(); process.exit(1); });
