/**
 * 完成度盘点（只读）。
 *
 * 存在的意义：回答"还有哪些没完成"时，**不能凭记忆列**。代码存在、表建好了、
 * 但里面一行数据都没有 —— 这三件事在报告里长得一模一样。
 * 这个脚本量的是**数据**，因为"表建好"与"功能能用"之间隔着数据。
 */
import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.PGHOST, user: process.env.PGUSER, password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE ?? 'postgres',
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20_000,
});

async function main() {
  const one = async (sql: string): Promise<number> => {
    const r = await pool.query<{ n: string }>(sql);
    return Number(r.rows[0]?.n ?? 0);
  };

  const rows: [string, number, string][] = [
    ['staff（员工档案）', await one('select count(*)::text n from public.staff'),
      '员工端登录的前置：无档案 ⇒ /api/staff/me 一律 409'],
    ['staff 已关联账号', await one('select count(*)::text n from public.staff where user_id is not null'),
      '无关联 ⇒ 没人能真正登进员工端'],
    ['staff_shifts（排班）', await one('select count(*)::text n from public.staff_shifts'), '员工端"我的排班"为空'],
    ['staff_attendance（考勤）', await one('select count(*)::text n from public.staff_attendance'), '打卡可写，但没有历史可看'],
    ['staff_care_notes', await one('select count(*)::text n from public.staff_care_notes'), '关怀记录为空'],
    ['staff_care_tasks', await one('select count(*)::text n from public.staff_care_tasks'), '关怀待办为空（需跑信号计算）'],
    ['public_sites（官网）', await one('select count(*)::text n from public.public_sites'), '已有 1 条演示站点'],
    ['store_qr_codes（点餐入口）', await one('select count(*)::text n from public.store_qr_codes'), '含 WEB 网页桌号'],
    ['products / orders', await one('select count(*)::text n from public.products'), '种子商品'],
    ['delivery_orders（外卖单）', await one('select count(*)::text n from public.delivery_orders'),
      '无单 ⇒ 认单/派单/轨迹全链路无法验证'],
    ['delivery_positions（骑手轨迹）', await one('select count(*)::text n from public.delivery_positions'),
      '无轨迹 ⇒ ETA 端点从未被真实调用'],
    ['customer_accounts（顾客账号）', await one('select count(*)::text n from public.customer_accounts'),
      '无账号 ⇒ 顾客登录/订单历史/地址簿从未跑通'],
    ['customer_sessions', await one('select count(*)::text n from public.customer_sessions'), '无会话'],
  ];

  console.log('  量                       数量   含义');
  console.log('  ' + '-'.repeat(76));
  for (const [label, n, note] of rows) {
    console.log(`  ${label.padEnd(24)} ${String(n).padStart(4)}   ${note}`);
  }

  const settings = await pool.query<{ delivery: unknown }>(
    "select delivery from public.settings where tenant_id = '00000000-0000-0000-0000-000000000000'",
  );
  console.log(`\n  settings.delivery = ${JSON.stringify(settings.rows[0]?.delivery ?? {})}`);
  console.log('  外卖默认关闭 ⇒ 顾客端 PWA 不显示"外卖"tab，配送链路不可达');

  await pool.end();
}

main().catch(async (e) => { console.error('[FAIL]', e.message); await pool.end(); process.exit(1); });
