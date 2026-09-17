/**
 * Phase 15 — 核验 runtime_* 审计元数据**真的落库了**（只读）。
 *
 * 迁移只证明"列存在"；`_apply_runtime_metadata_migration.mts` 的 +5 列是
 * schema 层面的证据。真正要回答的是：应用有没有**写入**它？
 *
 * 判据：迁移**之前**创建的会话，其 `runtime_*` 应为 NULL（那时列不存在）；
 * 迁移**之后**跑过一轮对话的会话，应当有非 NULL 的 `runtime_mode` /
 * `runtime_agent` / `runtime_at`。两类并存才说明是"新写入"而不是"都被填了默认值"。
 */
import * as supabaseModule from '../src/storage/database/supabase-client';

type Row = Record<string, unknown>;
type Res = { data: Row[] | null; error: { message: string } | null };

const getSupabaseClient = (supabaseModule as unknown as { getSupabaseClient?: () => unknown }).getSupabaseClient
  ?? (supabaseModule as unknown as { default?: { getSupabaseClient?: () => unknown } }).default?.getSupabaseClient;
if (!getSupabaseClient) throw new Error('getSupabaseClient not resolvable');

async function main(): Promise<number> {
  const client = getSupabaseClient!();
  const { data, error } = await (client as unknown as {
    from(t: string): {
      select(c: string): { order(c: string, o: { ascending: boolean }): { limit(n: number): Promise<Res> } };
    };
  }).from('chat_sessions')
    .select('id, title, runtime_mode, runtime_agent, runtime_request_class, runtime_at, created_at')
    .order('created_at', { ascending: false })
    .limit(60);

  console.log('='.repeat(90));
  console.log('Phase 15 — runtime_* 审计元数据落库核验');
  console.log('='.repeat(90));

  if (error) { console.log(`读取失败: ${error.message}`); return 2; }
  const rows = data ?? [];
  console.log(`chat_sessions 取回 ${rows.length} 行（按 created_at 倒序）`);
  console.log('');

  const withMeta = rows.filter((r) => r.runtime_mode !== null && r.runtime_mode !== undefined);
  const withoutMeta = rows.filter((r) => r.runtime_mode === null || r.runtime_mode === undefined);

  console.log(`有 runtime_mode 的行: ${withMeta.length}`);
  console.log(`无 runtime_mode 的行: ${withoutMeta.length}（迁移前的历史会话，应为 NULL）`);
  console.log('');

  console.log('最近 15 行:');
  console.log(`${'created_at'.padEnd(26)} ${'runtime_mode'.padEnd(12)} ${'runtime_agent'.padEnd(12)} ${'request_class'.padEnd(16)} title`);
  console.log('-'.repeat(90));
  for (const r of rows.slice(0, 15)) {
    console.log(
      `${String(r.created_at).slice(0, 24).padEnd(26)} `
      + `${String(r.runtime_mode ?? '(NULL)').padEnd(12)} `
      + `${String(r.runtime_agent ?? '(NULL)').padEnd(12)} `
      + `${String(r.runtime_request_class ?? '(NULL)').padEnd(16)} `
      + `${String(r.title ?? '').slice(0, 28)}`,
    );
  }

  console.log('');
  console.log('='.repeat(90));
  const ok = withMeta.length > 0;
  console.log(ok
    ? `结论: 有 ${withMeta.length} 行带 runtime 元数据 —— 应用确实在写这些列（迁移生效）。`
    : '结论: 没有任何一行带 runtime 元数据 —— 列存在但应用没写，需要进一步排查。');
  console.log('='.repeat(90));
  return ok ? 0 : 1;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 800).unref(); })
  .catch((e: unknown) => { console.error('崩溃:', e); process.exitCode = 2; });
