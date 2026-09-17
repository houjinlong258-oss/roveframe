/**
 * Phase 15 — 应用 `scripts/migrate-runtime-metadata.sql`（DDL，幂等）。
 *
 * ## 为什么需要它
 *
 * `src/app/api/agent/chat/route.ts` 每轮对话都写 `chat_sessions` 的 5 个
 * `runtime_*` 列，但真实库没有这些列（实测该表只有 9 列），生产日志持续出现：
 *   [agent/chat] runtime metadata columns unavailable;
 *     Could not find the 'runtime_agent' column of 'chat_sessions'
 *
 * 后果：审计元数据（"这条回答是 Runtime 出的还是 TS 降级出的"）**从未写入过**。
 *
 * ## 安全性
 *
 * - 凭据只从环境变量 `RF_DB_PASSWORD` 读，**不落盘、不打印**。
 * - 迁移文件本身全部使用 `ADD COLUMN IF NOT EXISTS`，可重复执行。
 * - 执行前后各查一次 `information_schema.columns`，用**列数变化**证明效果，
 *   而不是只看"没报错"。
 */
import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REF = 'omoyrubbsjquadopbjoo';
const PASSWORD = process.env.RF_DB_PASSWORD ?? '';
const TARGET_COLUMNS = [
  'runtime_mode', 'runtime_agent', 'runtime_request_class',
  'runtime_tool_intent', 'runtime_at',
];

/** 候选连接串：直连（IPv6）优先，其后是 Session pooler（IPv4）。 */
function candidates(): Array<{ label: string; dsn: string }> {
  const pw = encodeURIComponent(PASSWORD);
  return [
    { label: 'direct db.<ref> (IPv6)', dsn: `postgresql://postgres:${pw}@db.${REF}.supabase.co:5432/postgres` },
    { label: 'pooler aws-0-us-east-1', dsn: `postgresql://postgres.${REF}:${pw}@aws-0-us-east-1.pooler.supabase.com:5432/postgres` },
    { label: 'pooler aws-1-us-east-1', dsn: `postgresql://postgres.${REF}:${pw}@aws-1-us-east-1.pooler.supabase.com:5432/postgres` },
    { label: 'pooler aws-0-us-west-1', dsn: `postgresql://postgres.${REF}:${pw}@aws-0-us-west-1.pooler.supabase.com:5432/postgres` },
  ];
}

interface ColumnRow { column_name: string }

async function columnsOf(client: Client): Promise<string[]> {
  const r = await client.query<ColumnRow>(
    `select column_name from information_schema.columns
      where table_schema='public' and table_name='chat_sessions'
      order by column_name`,
  );
  return r.rows.map((x) => x.column_name);
}

async function main(): Promise<number> {
  console.log('='.repeat(78));
  console.log('Phase 15 — 应用 runtime-metadata 迁移');
  console.log('='.repeat(78));
  console.log(`RF_DB_PASSWORD 已提供: ${Boolean(PASSWORD)}`);
  console.log('');

  if (!PASSWORD) {
    console.log('未提供 RF_DB_PASSWORD，退出。');
    return 2;
  }

  const sql = readFileSync(join(process.cwd(), 'scripts', 'migrate-runtime-metadata.sql'), 'utf8');
  console.log(`迁移文件已读取: ${sql.length} 字符`);
  console.log('');

  let connected: Client | null = null;
  for (const { label, dsn } of candidates()) {
    const client = new Client({ connectionString: dsn, connectionTimeoutMillis: 15_000, ssl: { rejectUnauthorized: false } });
    const t0 = Date.now();
    try {
      await client.connect();
      console.log(`连接成功: ${label}（${Date.now() - t0} ms）`);
      connected = client;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`连接失败: ${label} — ${msg.slice(0, 120)}`);
      try { await client.end(); } catch { /* ignore */ }
    }
  }

  if (!connected) {
    console.log('');
    console.log('全部候选连接串均失败。');
    return 1;
  }
  const client = connected;

  try {
    // ---- 执行前 -----------------------------------------------------------
    const before = await columnsOf(client);
    console.log('');
    console.log(`[执行前] chat_sessions 共 ${before.length} 列`);
    const missingBefore = TARGET_COLUMNS.filter((c) => !before.includes(c));
    console.log(`         目标列缺失: ${missingBefore.length ? missingBefore.join(', ') : '无'}`);

    // ---- 执行 -------------------------------------------------------------
    console.log('');
    console.log('[执行] 运行 migrate-runtime-metadata.sql …');
    await client.query(sql);
    console.log('       命令返回成功（未抛错）');

    // ---- 执行后（用列数变化证明效果，而不是只看"没报错"）------------------
    const after = await columnsOf(client);
    console.log('');
    console.log(`[执行后] chat_sessions 共 ${after.length} 列（+${after.length - before.length}）`);
    for (const c of TARGET_COLUMNS) {
      console.log(`         ${c.padEnd(24)} ${after.includes(c) ? '存在' : '**仍缺失**'}`);
    }

    const stillMissing = TARGET_COLUMNS.filter((c) => !after.includes(c));
    console.log('');
    console.log('='.repeat(78));
    if (stillMissing.length === 0) {
      console.log('结果: 5 个 runtime_* 列全部就位。审计元数据从此可以落库。');
      return 0;
    }
    console.log(`结果: 仍缺 ${stillMissing.join(', ')}`);
    return 1;
  } finally {
    await client.end().catch(() => { /* ignore */ });
  }
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 500).unref(); })
  .catch((e: unknown) => { console.error('崩溃:', e); process.exitCode = 2; });
