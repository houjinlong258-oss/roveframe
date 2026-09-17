/**
 * Phase 15 — "全新部署会缺什么"核验（只读）。
 *
 * ## 为什么查这个
 *
 * `src/lib/migration.ts` 的 `MIGRATION_FILES` 只执行 4 个 SQL：
 *   migrate.sql / migrate-business-tables.sql / migrate-pilot-ready.sql /
 *   migrate-runtime-metadata.sql
 *
 * 但 `scripts/` 下另有 5 个迁移**不在清单里**，而它们创建的表/视图正被现网功能使用：
 *
 * | 迁移 | 创建的对象 | 依赖它的功能 |
 * |---|---|---|
 * | migrate-platform-admin.sql | platform_admins / platform_admin_sessions / subscription_plans / tenant_subscriptions / subscription_events | `/api/admin/*`（平台管理台） |
 * | migrate-production-hardening.sql | error_events / coding_proposals / audit_logs | coding-agent 审批流、错误事件 |
 * | migrate-customer-favorites.sql | customer_favorites | 顾客端收藏（公开接口） |
 * | migrate-ai-provider-views.sql | ai_providers / ai_credentials / ai_usage_logs 视图 | provider 只读视图 |
 * | migrate-rls.sql | 33 张表的 RLS 策略 | 数据库层租户隔离 |
 *
 * ## 本脚本回答
 *
 * 这些对象**现在**在库里存在吗？存在 → 说明是**手工应用**的（当前环境侥幸可用）；
 * 不存在 → 说明相关功能在本环境已坏。
 *
 * 无论哪种，"新部署只跑 4 个迁移"都会缺这些对象 —— 这是部署链的缺口，
 * 不是数据问题。本脚本只取证，不改动。
 */
import { Client } from 'pg';

const REF = 'omoyrubbsjquadopbjoo';
const PASSWORD = process.env.RF_DB_PASSWORD ?? '';

/** 迁移文件 → 它创建的对象（表用 'r'，视图用 'v'） */
const EXPECTED: Array<{ migration: string; auto: boolean; objects: Array<[string, 'r' | 'v']> }> = [
  {
    migration: 'migrate-platform-admin.sql', auto: false,
    objects: [
      ['platform_admins', 'r'], ['platform_admin_sessions', 'r'],
      ['subscription_plans', 'r'], ['tenant_subscriptions', 'r'],
      ['subscription_events', 'r'], ['invoices', 'r'],
      ['feature_entitlements', 'r'], ['support_access_grants', 'r'],
      ['platform_admin_audit_logs', 'r'],
    ],
  },
  {
    migration: 'migrate-production-hardening.sql', auto: false,
    objects: [['error_events', 'r'], ['coding_proposals', 'r'], ['audit_logs', 'r']],
  },
  {
    migration: 'migrate-customer-favorites.sql', auto: false,
    objects: [['customer_favorites', 'r']],
  },
  {
    migration: 'migrate-ai-provider-views.sql', auto: false,
    objects: [['ai_providers', 'v'], ['ai_credentials', 'v'], ['ai_usage_logs', 'v']],
  },
];

async function main(): Promise<number> {
  if (!PASSWORD) { console.log('未提供 RF_DB_PASSWORD'); return 2; }
  const pw = encodeURIComponent(PASSWORD);
  const client = new Client({
    connectionString: `postgresql://postgres:${pw}@db.${REF}.supabase.co:5432/postgres`,
    connectionTimeoutMillis: 15_000, ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  console.log('='.repeat(88));
  console.log('Phase 15 — 全新部署缺口核验（只读）');
  console.log('='.repeat(88));

  try {
    let missingTotal = 0;
    let presentTotal = 0;

    for (const group of EXPECTED) {
      console.log('');
      console.log(`--- ${group.migration}  (auto-migrate 包含: ${group.auto ? '是' : '**否**'}) ---`);
      for (const [name, kind] of group.objects) {
        const r = await client.query<{ exists: boolean }>(
          `select to_regclass($1) is not null as exists`, [`public.${name}`],
        );
        const exists = r.rows[0].exists;
        if (exists) presentTotal += 1; else missingTotal += 1;
        console.log(`    ${name.padEnd(30)} ${kind === 'v' ? 'view' : 'table'}  ${exists ? '存在' : '**缺失**'}`);
      }
    }

    console.log('');
    console.log('='.repeat(88));
    console.log(`统计: 现存 ${presentTotal} 个，缺失 ${missingTotal} 个`);
    console.log('');
    console.log('判读:');
    console.log('  · 现存 ⇒ 这些对象是**手工应用**的（当前环境因此侥幸可用）。');
    console.log('    但 `src/lib/migration.ts` 不会创建它们 ⇒ **全新部署会缺**。');
    console.log('  · 缺失 ⇒ 相应功能在本环境已不可用。');
    console.log('  两种都指向同一个部署链缺口，与本环境数据无关。');
    console.log('='.repeat(88));
    return 0;
  } finally {
    await client.end().catch(() => { /* ignore */ });
  }
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 400).unref(); })
  .catch((e: unknown) => { console.error('崩溃:', e); process.exitCode = 2; });
