/**
 * P0-14：迁移事实源比对脚本（CI）。
 *
 * 断言：
 * 1) schema.ts 中每个 pgTable 表名，至少出现在一个 scripts/migrate*.sql 文件中；
 * 2) boot-check REQUIRED_TABLES 全部被迁移覆盖；
 * 3) 关键唯一索引口径（settings/store_qr_codes/model_configs）为 tenant+business 形态。
 *
 * 用法：node scripts/verify-migrations.mjs（pnpm validate:migrations）
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

const schemaSource = read('src/storage/database/shared/schema.ts');

/**
 * Phase 15：迁移清单**只有一个事实源** —— `src/lib/migration.ts` 的 MIGRATION_FILES。
 *
 * 此前本文件自己维护第二份手写清单，已经漂移：
 *   · 它包含 `migrate-rls.sql`，而自动迁移**从不执行**该文件；
 *   · 它漏掉 `migrate-runtime-metadata.sql`、`migrate-platform-admin.sql` 等，
 *     于是"表是否被迁移覆盖"的断言在一份**并非实际执行**的清单上通过。
 *
 * 两份清单 = 两个真相。现在从源码里解析出唯一的真相。
 */
function autoMigrateFiles() {
  const src = read('src/lib/migration.ts');
  const block = src.match(/const\s+MIGRATION_FILES\s*=\s*\[([\s\S]*?)\]\s*as const;/);
  if (!block) {
    console.error('无法从 src/lib/migration.ts 解析 MIGRATION_FILES —— 迁移事实源已变更，请更新本脚本。');
    process.exit(1);
  }
  const files = [...block[1].matchAll(/'([^']+\.sql)'/g)].map((m) => m[1]);
  if (files.length === 0) {
    console.error('MIGRATION_FILES 解析结果为空 —— 拒绝在空清单上宣布通过。');
    process.exit(1);
  }
  return files;
}

const migrationList = autoMigrateFiles();
const sqlFiles = migrationList.map((p) => ({ name: p, content: read(p) }));
const sqlAll = sqlFiles.map((f) => f.content).join('\n');

const failures = [];

// 1) schema.ts 表名必须在迁移 SQL 中出现
const tableNames = [...schemaSource.matchAll(/export const \w+ = pgTable\(\s*["']([\w]+)["']/g)]
  .map((m) => m[1]);
if (tableNames.length < 10) failures.push(`schema.ts 表名解析异常（仅 ${tableNames.length} 张）`);
for (const table of tableNames) {
  if (!sqlAll.includes(`public.${table}`)) {
    failures.push(`表 ${table} 未出现在任何迁移 SQL 中`);
  }
}

// 2) boot-check REQUIRED_TABLES 全部覆盖
const bootSource = read('src/lib/boot-check.ts');
const requiredTables = [...bootSource.matchAll(/^\s*'([\w]+)',?$/gm)].map((m) => m[1]);
for (const table of requiredTables) {
  if (!sqlAll.includes(`public.${table}`)) {
    failures.push(`boot-check 必需表 ${table} 未出现在迁移 SQL 中`);
  }
}

// 3) 关键唯一索引口径：tenant+business
const mustBeTenantBusinessUnique = [
  { table: 'settings', re: /settings_tenant_business_key[\s\S]{0,120}\(tenant_id, business_id\)/ },
  { table: 'store_qr_codes', re: /store_qr_codes_tenant_business_table_no_key unique \(tenant_id, business_id, table_no\)/ },
  { table: 'model_configs', re: /model_configs_tenant_business_provider_key on public\.model_configs \(tenant_id, business_id, provider\)/ },
  { table: 'integration_configs', re: /integration_configs_tenant_business_provider_key on public\.integration_configs \(tenant_id, business_id, provider\)/ },
];
for (const { table, re } of mustBeTenantBusinessUnique) {
  if (!re.test(sqlAll)) failures.push(`${table} 缺少 tenant+business 唯一索引口径`);
}

// 4) 订单幂等部分唯一索引 + 预约权威金额
if (!/orders_qr_idempotency_idx[\s\S]{0,200}\(tenant_id, business_id, external_id\)[\s\S]{0,120}where source = 'qr' and external_id is not null/.test(sqlAll)) {
  failures.push('orders_qr_idempotency_idx 部分唯一索引缺失');
}
if (!/add column if not exists due_amount numeric\(10,2\)/.test(sqlAll)) {
  failures.push('reservations.due_amount 缺失');
}

if (failures.length > 0) {
  console.error('迁移事实源比对失败：');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`迁移事实源比对通过：schema ${tableNames.length} 张表全部覆盖，唯一索引口径一致。`);
