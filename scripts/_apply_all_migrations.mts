/**
 * 按 `src/lib/migration.ts` 的 `MIGRATION_FILES` 顺序，把整条迁移链应用到真实库。
 *
 * ## 为什么不是逐个文件手动跑
 *
 * 两个理由，都不是省事：
 *
 * 1. **顺序是事实源的一部分。** 逐个手跑会让人按记忆排序，而 migration.ts 里的顺序
 *    编码了依赖（platform-admin 依赖 tenants/businesses 等前置对象）。
 *    从源码解析清单，就不会出现"我以为是这个顺序"。
 *
 * 2. **它顺带验证幂等性。** 目标库已经停在 Phase 16 状态 —— 基础迁移早就跑过一遍。
 *    因此这一轮会在"对象已存在"的库上**重跑整条链**。任何一个文件不幂等，
 *    这里就会红，而不是等到某次全新部署时才炸。
 *
 * 用法（密码只走环境变量，不落盘、不打印）：
 *   $env:PGHOST='aws-0-...pooler.supabase.com'; $env:PGUSER='postgres.<ref>';
 *   $env:PGPASSWORD='...'; npx tsx scripts/_apply_all_migrations.mts
 */
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

const host = process.env.PGHOST;
const user = process.env.PGUSER;
const password = process.env.PGPASSWORD;
const database = process.env.PGDATABASE ?? 'postgres';
const port = Number(process.env.PGPORT ?? 5432);

if (!host || !user || !password) {
  console.error('缺 PGHOST / PGUSER / PGPASSWORD');
  process.exit(2);
}

/** 从事实源解析清单，绝不在本文件里再写一份 —— 两份清单必然漂移。 */
function migrationFiles(): string[] {
  const src = readFileSync('src/lib/migration.ts', 'utf8');
  const block = src.match(/const\s+MIGRATION_FILES\s*=\s*\[([\s\S]*?)\]\s*as const;/);
  if (!block) {
    console.error('无法从 src/lib/migration.ts 解析 MIGRATION_FILES');
    process.exit(2);
  }
  const files = [...block[1].matchAll(/'([^']+\.sql)'/g)].map((m) => m[1]);
  if (files.length === 0) {
    console.error('解析结果为空 —— 拒绝在空清单上宣布成功');
    process.exit(2);
  }
  return files;
}

async function main(): Promise<number> {
  const files = migrationFiles();
  console.log(`迁移链共 ${files.length} 个文件（顺序取自 src/lib/migration.ts）\n`);

  const pool = new Pool({
    host, user, password, database, port,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20_000,
    // 迁移里有建索引的语句，给足时间；超时就明确失败，不要静默截断。
    statement_timeout: 120_000,
  });

  /**
   * 必须有这个监听器。
   *
   * node-postgres 在**池中某个连接异常断开**时会在 Pool 上 emit `'error'`。
   * 没有监听器时 Node 把它当未捕获异常直接终止进程 —— 实测表现就是这个脚本
   * 打印 "Connection terminated unexpectedly" 然后整进程退出，
   * 我的 per-file try/catch 根本没机会执行，看起来像迁移逻辑错了，其实是 Crash。
   *
   * 这里只记录，让对应的 query 自己以 rejection 形式抛给上层 catch。
   */
  pool.on('error', (error) => {
    console.error(`  [pool] 连接异常（由 query 自身报错，不中断整轮）: ${error.message}`);
  });

  // lock_timeout 不是 node-postgres 的构造选项（写了也会被忽略），
  // 必须用 SET 显式设置。它让锁等待快速失败并说清原因，
  // 而不是挂到 Session pooler 主动掐断连接。
  try {
    await pool.query("set lock_timeout = '15s'");
  } catch (error) {
    console.error(`  无法设置 lock_timeout（继续执行）: ${error instanceof Error ? error.message : String(error)}`);
  }

  const failed: string[] = [];

  try {
    for (const [index, file] of files.entries()) {
      const sql = readFileSync(file, 'utf8');
      const started = Date.now();
      const client = await pool.connect();
      try {
        // 一个文件一个事务：失败即整文件回滚，不留半吊子状态。
        await client.query('begin');
        await client.query(sql);
        await client.query('commit');
        console.log(`  [ok]   ${String(index + 1).padStart(2)}/${files.length}  ${file}  (${Date.now() - started} ms)`);
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        console.error(`  [FAIL] ${String(index + 1).padStart(2)}/${files.length}  ${file}`);
        console.error(`         ${error instanceof Error ? error.message : String(error)}`);
        failed.push(file);
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }

  if (failed.length > 0) {
    console.error(`\n失败 ${failed.length} 个文件：`);
    for (const f of failed) console.error('  ' + f);
    return 1;
  }
  console.log('\n整条链应用成功。');
  return 0;
}

process.exit(await main());
