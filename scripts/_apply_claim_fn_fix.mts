/**
 * Phase 15 — 把修好的 `claim_agent_task_runs` 应用到真实库（**DDL**）。
 *
 * ## 背景
 *
 * 该函数此前 OUT 参数与表列重名，导致 `42702: column reference "attempt" is
 * ambiguous`，**每次调用都失败**。而 worker 的 `claimTaskRuns()` 写着
 * `if (error) return []`，把失败静默成"本轮没有任务" —— 于是 21 行
 * `agent_task_runs` 满足全部认领条件却全部停在 pending，最久 11 天，
 * 调度器日志一片干净。
 *
 * ## 本脚本做什么
 *
 * 从 `scripts/migrate.sql` 中**只截取**该函数的那一段（`create or replace
 * function public.claim_agent_task_runs` 到其结尾 `$$;`）并在真实库执行。
 * 不跑整个 migrate.sql（那是给全新库用的，且本环境缺 DATABASE_URL 之外的
 * 一些前置对象）。
 *
 * 执行后用**真实调用**验证（而不是只确认 DDL 没报错）。
 *
 * 凭据只从环境变量读，不落盘、不打印。
 */
import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REF = 'omoyrubbsjquadopbjoo';
const PASSWORD = process.env.RF_DB_PASSWORD ?? '';

/** 从 migrate.sql 抽出该函数的 DDL 段（含前置的 drop，因为返回类型变了） */
function extractFunction(sql: string, signature: string): string {
  // 从 drop 开始截取，确保 create 之前先 drop（Postgres 不允许 replace 改返回类型）
  const dropAt = sql.lastIndexOf('drop function if exists public.claim_agent_task_runs', sql.indexOf(signature));
  const start = dropAt >= 0 ? dropAt : sql.indexOf(signature);
  if (start < 0) throw new Error(`未找到函数定义: ${signature}`);
  const end = sql.indexOf('\n$$;', start);
  if (end < 0) throw new Error(`未找到函数结尾: ${signature}`);
  return sql.slice(start, end + '\n$$;'.length);
}

async function main(): Promise<number> {
  console.log('='.repeat(84));
  console.log('Phase 15 — 修复并应用 claim_agent_task_runs');
  console.log('='.repeat(84));
  if (!PASSWORD) { console.log('未提供 RF_DB_PASSWORD'); return 2; }

  const migrateSql = readFileSync(join(process.cwd(), 'scripts', 'migrate.sql'), 'utf8');
  const fnSql = extractFunction(
    migrateSql,
    'function public.claim_agent_task_runs(p_worker_id text, p_limit integer default 10)',
  );
  console.log(`抽取函数 DDL: ${fnSql.length} 字符`);
  console.log(`含 out_ 前缀参数: ${/out_attempt/.test(fnSql) ? '是' : '否（修丁未生效，中止）'}`);
  if (!/out_attempt/.test(fnSql)) return 1;

  const client = new Client({
    connectionString: `postgresql://postgres:${encodeURIComponent(PASSWORD)}@db.${REF}.supabase.co:5432/postgres`,
    connectionTimeoutMillis: 15_000, ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    // 授权语句与函数定义在同一段之后，单独执行（create or replace 会重置权限，
    // 必须重新 grant，否则 service_role 可能失去 execute）。
    console.log('[1] 执行 create or replace function …');
    await client.query(fnSql);
    console.log('    DDL 返回成功');

    console.log('[2] 重新授权（create or replace 会重置函数权限）');
    await client.query('revoke all on function public.claim_agent_task_runs(text, integer) from public, anon, authenticated');
    await client.query('grant execute on function public.claim_agent_task_runs(text, integer) to service_role');
    console.log('    已 grant 给 service_role');

    // ---- 用真实调用验证（不是只看 DDL 没报错）----------------------------
    console.log('[3] 真实调用验证');
    const probe = await client.query(
      `select * from public.claim_agent_task_runs('phase15-verify-probe', 1)`,
    );
    console.log(`    返回 ${probe.rows.length} 行`);
    if (probe.rows.length > 0) {
      const r = probe.rows[0];
      console.log(`    字段: ${Object.keys(r).join(', ')}`);
      console.log(`    out_id=${String(r.out_id).slice(0, 8)}… out_task_type=${r.out_task_type} out_attempt=${r.out_attempt}/${r.out_max_attempts}`);
      const shaped = 'out_id' in r && 'out_attempt' in r && 'out_task_type' in r;
      console.log(`    形状符合 out_* 约定: ${shaped ? '是' : '**否**'}`);
      // 还原这一行（仅诊断，不真的执行任务）
      await client.query(
        `update public.agent_task_runs
            set status='pending', claimed_by=null, claimed_at=null,
                locked_by=null, locked_at=null, started_at=null
          where claimed_by='phase15-verify-probe'`,
      );
      console.log('    已把探测行还原为 pending（不执行任务）');
      console.log('');
      console.log('='.repeat(84));
      console.log(shaped
        ? '结果: 函数已修复并可被真实调用 —— 队列从此可以被消费。'
        : '结果: 调用成功但字段名不符合约定，worker 会拿到 undefined。');
      console.log('='.repeat(84));
      return shaped ? 0 : 1;
    }

    console.log('');
    console.log('='.repeat(84));
    console.log('结果: 调用成功但认领 0 行（可能 pending 已被清空）—— 函数本身可用。');
    console.log('='.repeat(84));
    return 0;
  } finally {
    await client.end().catch(() => { /* ignore */ });
  }
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 500).unref(); })
  .catch((e: unknown) => { console.error('崩溃:', e); process.exitCode = 2; });
