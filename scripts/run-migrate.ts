/* eslint-disable no-console */
// 自动执行建表：调用 lib/migration 的 autoMigrate
// 用法: pnpm tsx scripts/run-migrate.ts
import { autoMigrate } from '../src/lib/migration';
import { loadEnv } from '../src/storage/database/supabase-client';

async function main(): Promise<void> {
  loadEnv();
  console.log('检测建表凭据...');
  const r = await autoMigrate();
  if (r.ok) {
    console.log(`✅ 建表完成（${r.method === 'pg-dsn' ? 'Postgres 直连' : 'Supabase Management API'}）`);
  } else {
    console.log('⚠️ 自动建表未执行：', r.error);
    console.log('   - 手动：在 Supabase SQL Editor 运行 scripts/migrate.sql');
    console.log('   - 自动：提供 DATABASE_URL（或 SUPABASE_ACCESS_TOKEN）后重跑本脚本');
  }
}

main().catch((err) => {
  console.error('迁移失败:', err instanceof Error ? err.message : err);
  process.exit(1);
});