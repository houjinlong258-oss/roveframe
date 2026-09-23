/**
 * Phase 15 / Phase 19 — 把修好的 claim 函数应用到真实库（**DDL**）。
 *
 * ## 背景
 *
 * 同一类缺陷发生过两次，两次都是 OUT 参数与表列重名导致 42702：
 *
 *   1. `claim_agent_task_runs` —— `attempt` 重名；调用方写着 `if (error) return []`，
 *      失败被静默成"本轮没有任务"，21 行任务卡住最久 11 天（Phase 15 修）。
 *   2. `claim_notification_outbox` —— `attempts` 重名；调用方**没有**吞错，
 *      调度器日志报 `column reference "attempts" is ambiguous`，48 行通知卡住 5.1 天
 *      （Phase 19 修，只有在生产入口 `node dist/server.js` 下才看得见）。
 *
 * ## 本脚本做什么
 *
 * 从 `scripts/migrate.sql` 中**只截取**目标函数那一段（`create or replace
 * function public.<name>` 到其结尾 `$$;`）并在真实库执行。不跑整个 migrate.sql
 * （那是给全新库用的，且本环境缺 DATABASE_URL 之外的一些前置对象）。
 *
 * 执行后用**真实调用**验证（而不是只确认 DDL 没报错），并把探测行还原。
 *
 * ## 用法
 *
 *   $env:RF_DB_PASSWORD='...'; npx tsx scripts/_apply_claim_fn_fix.mts              # 默认 task
 *   $env:RF_DB_PASSWORD='...'; npx tsx scripts/_apply_claim_fn_fix.mts notification
 *   $env:RF_DB_PASSWORD='...'; npx tsx scripts/_apply_claim_fn_fix.mts both
 *
 * 凭据只从环境变量读，不落盘、不打印。
 */
import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REF = 'omoyrubbsjquadopbjoo';
const PASSWORD = process.env.RF_DB_PASSWORD ?? '';

const TARGET = (process.argv[2] ?? 'task').toLowerCase();

interface FnSpec {
  /** 命令行参数名 */
  key: string;
  /** migrate.sql 里的函数签名（用于定位） */
  signature: string;
  /** 函数的完整签名（用于 grant/revoke 的实参类型） */
  callSignature: string;
  /** 修复生效的判据：修好后 body 里必须出现的片段 */
  fixMarker: RegExp;
  probeSql: string;
  /** 探针认领之后把行还原（不真的执行任务/投递） */
  restoreSql: string | null;
  /** 探针输出的形状判据 */
  shapeCheck: (row: Record<string, unknown>) => boolean;
}

const SPECS: FnSpec[] = [
  {
    key: 'task',
    signature: 'function public.claim_agent_task_runs(p_worker_id text, p_limit integer default 10)',
    callSignature: 'public.claim_agent_task_runs(text, integer)',
    fixMarker: /out_attempt/,
    probeSql: `select * from public.claim_agent_task_runs('phase15-verify-probe', 1)`,
    restoreSql: `update public.agent_task_runs
            set status='pending', claimed_by=null, claimed_at=null,
                locked_by=null, locked_at=null, started_at=null
          where claimed_by='phase15-verify-probe'`,
    shapeCheck: (r) => 'out_id' in r && 'out_attempt' in r && 'out_task_type' in r,
  },
  {
    key: 'notification',
    signature: 'function public.claim_notification_outbox(p_worker_id text, p_limit integer default 20)',
    callSignature: 'public.claim_notification_outbox(text, integer)',
    // 修好的判据：租约回收的 UPDATE 必须把列引用写全（否则又撞 42702）
    fixMarker: /n\.attempts >= n\.max_attempts/,
    probeSql: `select * from public.claim_notification_outbox('phase19-verify-probe', 1)`,
    restoreSql: `update public.notification_outbox
            set status='queued', claimed_by=null, claimed_at=null,
                attempts = greatest(0, attempts - 1)
          where claimed_by='phase19-verify-probe'`,
    shapeCheck: (r) => 'id' in r && 'channel' in r && 'attempts' in r && 'max_attempts' in r,
  },
];

/** 从 migrate.sql 抽出函数的 DDL 段（含前置的 drop，因为返回类型可能变了） */
function extractFunction(sql: string, signature: string): string {
  // 从 drop 开始截取，确保 create 之前先 drop（Postgres 不允许 replace 改返回类型）
  const fnName = /function public\.([a-z_]+)/.exec(signature)?.[1] ?? '';
  const dropAt = sql.lastIndexOf(`drop function if exists public.${fnName}`, sql.indexOf(signature));
  const start = dropAt >= 0 ? dropAt : sql.indexOf(signature);
  if (start < 0) throw new Error(`未找到函数定义: ${signature}`);
  const end = sql.indexOf('\n$$;', start);
  if (end < 0) throw new Error(`未找到函数结尾: ${signature}`);
  return sql.slice(start, end + '\n$$;'.length);
}

async function applyOne(client: Client, spec: FnSpec): Promise<number> {
  console.log('='.repeat(84));
  console.log(`应用 claim 函数修复: ${spec.key}`);
  console.log('='.repeat(84));

  const migrateSql = readFileSync(join(process.cwd(), 'scripts', 'migrate.sql'), 'utf8');
  const fnSql = extractFunction(migrateSql, spec.signature);
  console.log(`抽取函数 DDL: ${fnSql.length} 字符`);
  const fixed = spec.fixMarker.test(fnSql);
  console.log(`修复判据 ${spec.fixMarker} 命中: ${fixed ? '是' : '否（改动未生效，中止）'}`);
  if (!fixed) return 1;

  // 授权语句与函数定义在同一段之后，单独执行（create or replace 会重置权限，
  // 必须重新 grant，否则 service_role 可能失去 execute）。
  console.log('[1] 执行 create or replace function …');
  await client.query(fnSql);
  console.log('    DDL 返回成功');

  console.log('[2] 重新授权（create or replace 会重置函数权限）');
  await client.query(`revoke all on function ${spec.callSignature} from public, anon, authenticated`);
  await client.query(`grant execute on function ${spec.callSignature} to service_role`);
  console.log('    已 grant 给 service_role');

  // ---- 用真实调用验证（不是只看 DDL 没报错）----------------------------
  console.log('[3] 真实调用验证');
  const probe = await client.query(spec.probeSql);
  console.log(`    返回 ${probe.rows.length} 行`);
  if (probe.rows.length > 0) {
    const r = probe.rows[0] as Record<string, unknown>;
    console.log(`    字段: ${Object.keys(r).join(', ')}`);
    const shaped = spec.shapeCheck(r);
    console.log(`    形状符合约定: ${shaped ? '是' : '**否**'}`);
    if (spec.restoreSql) {
      await client.query(spec.restoreSql);
      console.log('    已把探测行还原（不真的执行任务/投递）');
    }
    console.log(shaped
      ? `结果: ${spec.key} 已修复并可被真实调用 —— 队列从此可以被消费。`
      : `结果: 调用成功但字段名不符合约定，调用方会拿到 undefined。`);
    return shaped ? 0 : 1;
  }
  console.log(`结果: 调用成功但认领 0 行（可能队列已空）—— 函数本身可用。`);
  return 0;
}

async function main(): Promise<number> {
  if (!PASSWORD) { console.log('未提供 RF_DB_PASSWORD'); return 2; }

  const specs = TARGET === 'both'
    ? SPECS
    : SPECS.filter((s) => s.key === TARGET);
  if (specs.length === 0) {
    console.log(`未知目标: ${TARGET}（可选 ${SPECS.map((s) => s.key).join(' | ')} | both）`);
    return 2;
  }

  const client = new Client({
    connectionString: `postgresql://postgres:${encodeURIComponent(PASSWORD)}@db.${REF}.supabase.co:5432/postgres`,
    connectionTimeoutMillis: 15_000, ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    let worst = 0;
    for (const spec of specs) {
      const code = await applyOne(client, spec);
      if (code !== 0) worst = code;
      console.log('');
    }
    return worst;
  } finally {
    await client.end().catch(() => { /* ignore */ });
  }
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 500).unref(); })
  .catch((e: unknown) => { console.error('崩溃:', e); process.exitCode = 2; });
