import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';

/**
 * P0-14：单一迁移事实源。
 *
 * 建表 DDL 的权威来源是磁盘上的 SQL 文件：
 *   1) scripts/migrate.sql                 —— 平台表 + 增量迁移（幂等）
 *   2) scripts/migrate-business-tables.sql —— 业务表 + pgvector RAG（幂等）
 *
 * autoMigrate 仅按顺序执行这两个文件；不再内嵌第二份 SQL 副本，
 * 杜绝「自动迁移建出的库与 schema/代码不符」的漂移。
 * scripts/verify-migrations.mjs 在 CI 中断言 SQL 文件与 schema.ts 表名一致。
 */

export interface MigrateResult {
  ok: boolean;
  method: 'pg-dsn' | 'management-api' | 'none';
  error?: string;
}

const MIGRATION_FILES = [
  'scripts/migrate.sql',
  'scripts/migrate-business-tables.sql',
  'scripts/migrate-pilot-ready.sql',
] as const;

/** 读取迁移 SQL 文件；cwd=仓库根或打包产物上一级均可命中。 */
function migrationSql(): string {
  const candidates = [
    process.cwd(),
    path.resolve(__dirname, '..'),
    path.resolve(__dirname, '..', '..'),
  ];
  const chunks: string[] = [];
  for (const relative of MIGRATION_FILES) {
    let found: string | null = null;
    for (const root of candidates) {
      const absolute = path.join(root, relative);
      try {
        found = readFileSync(absolute, 'utf8');
        break;
      } catch {
        // try next candidate root
      }
    }
    if (found === null) {
      throw new Error(
        `migration SQL file not found: ${relative}. Run from the repository root ` +
        '(scripts/migrate*.sql files are the single source of truth).',
      );
    }
    chunks.push(found);
  }
  return chunks.join('\n');
}

const DSN_KEYS = [
  'DATABASE_URL',
  'POSTGRES_URL',
  'DIRECT_URL',
  'COZE_SUPABASE_DATABASE_URL',
  'SUPABASE_DATABASE_URL',
  'PG_CONNECTION_STRING',
];

/** 从 COZE_SUPABASE_URL（https://<ref>.supabase.co）解析项目 ref */
function projectRef(): string {
  const m = /https?:\/\/([^.]+)\.supabase\.co/.exec(process.env.COZE_SUPABASE_URL ?? '');
  return m?.[1] ?? '';
}

/**
 * 自动建表：优先用 Postgres DSN；否则用 Supabase Management API。
 * 两者都缺失时返回 method=none（由调用方决定是否告警）。
 */
export async function autoMigrate(): Promise<MigrateResult> {
  const sql = migrationSql();

  // 1) Postgres 直连（pg）
  const dsn = DSN_KEYS.map((k) => process.env[k]).find((v): v is string => Boolean(v));
  if (dsn) {
    const pool = new Pool({ connectionString: dsn, ssl: { rejectUnauthorized: false } });
    try {
      await pool.query(sql);
      return { ok: true, method: 'pg-dsn' };
    } catch (e) {
      return { ok: false, method: 'pg-dsn', error: e instanceof Error ? e.message : String(e) };
    } finally {
      await pool.end();
    }
  }

  // 2) Supabase Management API（需要 SUPABASE_ACCESS_TOKEN）
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const ref = projectRef();
  if (token && ref) {
    const resp = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }),
    });
    if (resp.ok) return { ok: true, method: 'management-api' };
    return { ok: false, method: 'management-api', error: `HTTP ${resp.status}: ${await resp.text()}` };
  }

  return { ok: false, method: 'none', error: '未配置 DATABASE_URL 或 SUPABASE_ACCESS_TOKEN' };
}
