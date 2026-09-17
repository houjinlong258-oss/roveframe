/**
 * Phase 15 — 列名真值核查（只读）。
 *
 * 触发原因：`_diagnose_decrypt_failures.mts` 按 AGENTS.md 与 Phase 12 报告的
 * 说法去读 `model_configs.credentials` / `email_accounts.credentials` /
 * `integration_configs.credentials`，三张表都报
 * "column ... does not exist"。
 *
 * 说明"凭据存在哪个列"这个前提本身需要先验证。本脚本用 `select('*')` 取一行，
 * 直接列出**真实列名**，不做任何猜测。
 */
import * as supabaseModule from '../src/storage/database/supabase-client';

type Row = Record<string, unknown>;
type Res = { data: Row[] | null; error: { message: string } | null };

const getSupabaseClient = (supabaseModule as unknown as { getSupabaseClient?: () => unknown }).getSupabaseClient
  ?? (supabaseModule as unknown as { default?: { getSupabaseClient?: () => unknown } }).default?.getSupabaseClient;
if (!getSupabaseClient) throw new Error('getSupabaseClient not resolvable');

const TABLES = [
  'model_configs', 'email_accounts', 'integration_configs', 'settings',
  'email_accounts', 'chat_sessions',
] as const;

/** 只打印"看起来像凭据/密钥"的列名及其取值形态，不打印明文值本身。 */
const SECRET_HINT = /(credential|secret|token|key|password|auth|api_key)/i;

function describeValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v !== 'string') return `${typeof v}`;
  const parts = v.split('.');
  if (parts.length === 3 && parts.every((p) => /^[A-Za-z0-9+/=_-]*$/.test(p))) {
    return `AES-GCM 密文形态?（3 段，长度 ${parts.map((p) => p.length).join(',')}）`;
  }
  try {
    const parsed: unknown = JSON.parse(v);
    if (parsed && typeof parsed === 'object') {
      return `JSON 对象，键=[${Object.keys(parsed as object).join(',')}]`;
    }
  } catch { /* not json */ }
  return `字符串（长度 ${v.length}）`;
}

async function main(): Promise<number> {
  const client = getSupabaseClient!();

  console.log('='.repeat(78));
  console.log('Phase 15 — 列名真值核查（不打印明文）');
  console.log('='.repeat(78));
  console.log('');

  for (const table of TABLES) {
    const { data, error } = await (client as unknown as {
      from(t: string): { select(c: string): { limit(n: number): Promise<Res> } };
    }).from(table).select('*').limit(1);

    console.log(`--- ${table} ---`);
    if (error) { console.log(`    ERR ${error.message}`); console.log(''); continue; }
    const row = (data ?? [])[0];
    if (!row) { console.log('    (无行，无法从数据取列名)'); console.log(''); continue; }

    const cols = Object.keys(row).sort();
    console.log(`    共 ${cols.length} 列`);
    const secretCols = cols.filter((c) => SECRET_HINT.test(c));
    console.log(`    疑似凭据列: ${secretCols.length ? secretCols.join(', ') : '(无)'}`);
    for (const c of secretCols) {
      console.log(`      ${c.padEnd(24)} ${describeValue(row[c])}`);
    }
    console.log('');
  }

  console.log('='.repeat(78));
  console.log('用途: 确定"凭据实际落在哪个列"，再对其调用生产 decrypt()。');
  console.log('='.repeat(78));
  return 0;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 1_500).unref(); })
  .catch((e: unknown) => { console.error('核查崩溃:', e); process.exitCode = 2; });
