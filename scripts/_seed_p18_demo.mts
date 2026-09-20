/**
 * 为演示商家准备一条**真实的已发布官网**与网页点单 token。
 *
 * ## 为什么需要它
 *
 * 库里目前没有任何 `public_sites` 行，所以 17 个公开接口只能验到"404 是对的" ——
 * 那只证明边界成立，不证明**数据能流出来**。要验第二条，必须有真实数据。
 *
 * ## 它做的两件事，都是在走产品自己的路径
 *
 *   1. 插一行 `store_qr_codes`（table_no='WEB'）：这正是
 *      `src/lib/public-site.ts::ensureWebOrderToken` 的实现方式，
 *      顾客端 PWA 的"立即下单"就靠它。
 *   2. 插一行已发布的 `public_sites`，内容取自该商家**真实的**
 *      businesses / settings / products，不编造文案。
 *
 * ## 幂等
 *
 * 两个 upsert 都带 onConflict，重复跑不会产生第二行。
 * 用完可以跑 --cleanup 精确删掉这两行（只删本脚本建的）。
 *
 * 用法：
 *   $env:PGHOST='aws-0-...pooler.supabase.com'; $env:PGUSER='postgres.<ref>'; $env:PGPASSWORD='...'
 *   npx tsx scripts/_seed_p18_demo.mts
 *   npx tsx scripts/_seed_p18_demo.mts --cleanup
 */
import { Pool } from 'pg';

const TENANT = '00000000-0000-0000-0000-000000000000';
const BUSINESS = '00000000-0000-0000-0000-000000000001';
const SLUG = 'demo-bistro';
const cleanup = process.argv.includes('--cleanup');

const pool = new Pool({
  host: process.env.PGHOST, user: process.env.PGUSER, password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE ?? 'postgres',
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20_000,
});

async function main() {
  if (cleanup) {
    const d1 = await pool.query('delete from public.public_sites where tenant_id=$1 and business_id=$2 and slug=$3', [TENANT, BUSINESS, SLUG]);
    const d2 = await pool.query("delete from public.store_qr_codes where tenant_id=$1 and business_id=$2 and table_no='WEB'", [TENANT, BUSINESS]);
    console.log(`已清理：public_sites ${d1.rowCount} 行，store_qr_codes ${d2.rowCount} 行`);
    return;
  }

  // 1) 网页点单 token —— 与 ensureWebOrderToken 同一形态
  const qr = await pool.query(
    `insert into public.store_qr_codes (tenant_id, business_id, table_no, remark, is_active, updated_at)
     values ($1, $2, 'WEB', 'Online ordering (website)', true, now())
     on conflict (tenant_id, business_id, table_no)
     do update set is_active = true, updated_at = now()
     returning public_token`,
    [TENANT, BUSINESS],
  );
  const token = String(qr.rows[0]?.public_token ?? '');

  // 2) 已发布官网 —— 内容全部取自商家真实数据，不编造
  const biz = await pool.query('select name, industry, location, currency from public.businesses where id=$1', [BUSINESS]);
  const settings = await pool.query('select business, locale, delivery from public.settings where tenant_id=$1 and business_id=$2', [TENANT, BUSINESS]);
  const businessJson = (settings.rows[0]?.business ?? {}) as Record<string, string>;
  const localeJson = (settings.rows[0]?.locale ?? {}) as Record<string, string>;
  const name = String(biz.rows[0]?.name ?? 'Demo Store');

  const site = await pool.query(
    `insert into public.public_sites
       (tenant_id, business_id, slug, enabled, tagline, about, sections, theme, seo, contact, web_order_token, generated_by, generated_at, published_at, updated_at)
     values ($1,$2,$3,true,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10,'manual',now(),now(),now())
     on conflict (tenant_id, business_id) do update
       set enabled = true, web_order_token = excluded.web_order_token,
           tagline = excluded.tagline, about = excluded.about,
           published_at = coalesce(public.public_sites.published_at, now()), updated_at = now()
     returning slug`,
    [
      TENANT, BUSINESS, SLUG,
      businessJson.intro ?? '',
      String(businessJson.intro ?? `${name} — ${String(biz.rows[0]?.industry ?? '')}`),
      JSON.stringify([
        { id: 'hero', kind: 'hero', heading: name, body: businessJson.intro ?? '' },
        { id: 'menu', kind: 'menu', heading: 'Menu', body: '' },
        { id: 'hours', kind: 'hours', heading: 'Opening hours', body: businessJson.hours ?? '' },
      ]),
      JSON.stringify({ primary: '#0f766e', accent: '#f59e0b', surface: '#ffffff', font: 'sans' }),
      JSON.stringify({ title: name, description: businessJson.intro ?? '' }),
      JSON.stringify({
        phone: businessJson.phone ?? '',
        email: businessJson.email ?? '',
        address: businessJson.address ?? String(biz.rows[0]?.location ?? ''),
        hours: businessJson.hours ?? '',
      }),
      token,
    ],
  );

  const products = await pool.query('select count(*)::int as n from public.products where tenant_id=$1 and business_id=$2 and status=$3', [TENANT, BUSINESS, 'active']);

  console.log(JSON.stringify({
    slug: String(site.rows[0]?.slug ?? ''),
    orderToken: token,
    activeProducts: products.rows[0]?.n ?? 0,
    settingsCurrency: localeJson.currency ?? '(none)',
  }, null, 2));
}

main()
  .then(() => pool.end())
  .catch(async (e) => { console.error('[FAIL]', e.message); await pool.end(); process.exit(1); });
