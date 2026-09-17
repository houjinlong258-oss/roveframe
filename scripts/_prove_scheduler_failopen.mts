/**
 * Phase 15 —— 证明 scheduler 的 cron_state 探测也是 fail-open（只读）。
 *
 * 报告 §4.3 断言：`src/lib/scheduler.ts` 原用
 * `select('key', {count:'exact', head:true})` 探测 `cron_state`，
 * 该形态对不存在的表恒返回 error=null，因此 `_cronStateReady` 恒为 true。
 *
 * 这一条之前是**从代码读出来的推理**，本脚本把它变成实测：
 * 用同一形态对确定不存在的表取值，看 `!error` 是否恒成立。
 */
import * as supabaseModule from '../src/storage/database/supabase-client';

type Res = { status?: number; error?: { message?: string; code?: string } | null; count?: number | null };

const getSupabaseClient = (supabaseModule as unknown as { getSupabaseClient?: () => unknown }).getSupabaseClient
  ?? (supabaseModule as unknown as { default?: { getSupabaseClient?: () => unknown } }).default?.getSupabaseClient;
if (!getSupabaseClient) throw new Error('getSupabaseClient not resolvable');

async function main(): Promise<number> {
  const client = getSupabaseClient!();
  const probe = (table: string): Promise<Res> =>
    (client as { from(t: string): { select(c: string, o?: unknown): Promise<Res> } })
      .from(table).select('key', { count: 'exact', head: true });

  console.log('='.repeat(78));
  console.log('Phase 15 — scheduler cron_state 探测的 fail-open 证明');
  console.log('='.repeat(78));
  console.log('形态: select("key", { count: "exact", head: true })   ← 修改前 scheduler.ts:46');
  console.log('');
  console.log(`${'table'.padEnd(34)} ${'status'.padEnd(8)} ${'!error (即 _cronStateReady)'.padEnd(28)} error`);
  console.log('-'.repeat(90));

  for (const t of [
    'cron_state',                              // 真实存在的表
    'zzz_definitely_not_a_table_9f3a',         // 阴性对照
    'public.also_not_real_7b1c',               // 阴性对照
  ]) {
    const r = await probe(t);
    const wouldBeReady = !r.error;
    console.log(
      `${t.padEnd(34)} ${String(r.status ?? '-').padEnd(8)} `
      + `${String(wouldBeReady).padEnd(28)} ${r.error?.message ?? '-'}`,
    );
  }

  console.log('');
  console.log('判读: 若阴性对照的 !error 也是 true，则修改前的 scheduler 在 cron_state');
  console.log('      缺失时仍会判定"就绪"，runScheduledJobsInner 会继续往下跑并在');
  console.log('      后续真实读取处才失败 —— health 的 degraded 永远不上报。');
  console.log('='.repeat(78));
  return 0;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 1_500).unref(); })
  .catch((e: unknown) => { console.error('崩溃:', e); process.exitCode = 2; });
