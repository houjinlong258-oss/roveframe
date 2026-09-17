/**
 * Phase 15 — 定位解密失败（只读，不打印明文）。
 *
 * ## 背景
 *
 * 真实容器日志反复出现：
 *   [agent/chat] memory extraction failed (non-blocking):
 *     Unsupported state or unable to authenticate data
 *   [agent/chat] memory extraction failed (non-blocking):
 *     API key is required. Set COZE_API_TOKEN or provide apiKey in config.
 *
 * `src/lib/crypto.ts` 的 `decrypt()` 是 fail-loud 的：GCM tag 不匹配即抛出，
 * 抛出的正是 "Unsupported state or unable to authenticate data"。所以这是
 * **真实的密钥不匹配**，不是环境缺配置。
 *
 * ## 本脚本做什么
 *
 * 对每个"凭据以 AES-256-GCM 密文落库"的列，逐行调用生产 `decrypt()`：
 *   - 成功 → 记 ok（**不打印任何明文**）
 *   - 失败 → 记录表名、行 id、密文长度、密文形态（几段），用于定位
 *
 * 形态约定：`<ivB64>.<tagB64>.<dataB64>`（3 段）。段数不对说明该列存的不是
 * 本模块的密文格式，是另一类问题，单独标注。
 */
import * as supabaseModule from '../src/storage/database/supabase-client';
import * as cryptoModule from '../src/lib/crypto';

type Row = Record<string, unknown>;
type Res = { data: Row[] | null; error: { message: string } | null };

function resolveExport<T>(mod: unknown, name: string): T {
  const m = mod as Record<string, unknown>;
  const direct = m?.[name];
  if (direct !== undefined) return direct as T;
  for (const carrier of ['default', 'module.exports']) {
    const bag = m?.[carrier] as Record<string, unknown> | undefined;
    const value = bag?.[name];
    if (value !== undefined) return value as T;
  }
  throw new Error(
    `cannot resolve export '${name}'; available: ${Object.keys(m ?? {}).join(', ')}`,
  );
}

const getSupabaseClient = resolveExport<() => {
  from(t: string): { select(c: string): { limit(n: number): Promise<Res> } };
}>(supabaseModule, 'getSupabaseClient');

const decrypt = resolveExport<(payload: string) => string>(cryptoModule, 'decrypt');

/**
 * (表, 密文列, id 列)。
 *
 * 列名经 `scripts/_verify_column_names.mts` 以 `select('*')` 实测确定，
 * **不是**按 AGENTS.md 的说法写的 —— 文档里写的 `credentials` 三张表都不存在，
 * 真实列名是 `api_key_encrypted` / `credentials_encrypted`。
 */
const CREDENTIAL_COLUMNS: Array<[string, string, string]> = [
  ['model_configs', 'api_key_encrypted', 'id'],
  ['email_accounts', 'credentials_encrypted', 'id'],
];

function shapeOf(value: string): string {
  const parts = value.split('.');
  if (parts.length !== 3) return `${parts.length} 段（非常规密文格式）`;
  const lens = parts.map((p) => p.length);
  return `3 段 / b64 长度 ${lens.join(',')}`;
}

async function main(): Promise<number> {
  const client = getSupabaseClient!();

  console.log('='.repeat(78));
  console.log('Phase 15 — 解密失败定位（只读，不打印明文）');
  console.log('='.repeat(78));
  console.log(`ENCRYPTION_SECRET 已配置: ${Boolean(process.env.ENCRYPTION_SECRET)}`);
  console.log(`ENCRYPTION_SECRET_PREVIOUS 已配置: ${Boolean(process.env.ENCRYPTION_SECRET_PREVIOUS)}`);
  console.log('');

  let totalOk = 0;
  const failures: string[] = [];

  for (const [table, column, idCol] of CREDENTIAL_COLUMNS) {
    const { data, error } = await client.from(table).select(`${idCol}, ${column}`).limit(200);
    if (error) {
      console.log(`[${table}] 读取失败: ${error.message}`);
      continue;
    }
    const rows = data ?? [];
    console.log(`[${table}] ${rows.length} 行，列 ${column}:`);

    for (const row of rows) {
      const id = String(row[idCol] ?? '?');
      const raw = row[column];
      if (raw === null || raw === undefined) {
        console.log(`    ${id.slice(0, 8)}…  (空值)`);
        continue;
      }
      if (typeof raw !== 'string') {
        console.log(`    ${id.slice(0, 8)}…  非字符串（${typeof raw}）`);
        continue;
      }
      try {
        decrypt(raw);
        totalOk += 1;
        console.log(`    ${id.slice(0, 8)}…  OK 可解密（${shapeOf(raw)}）`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const tag = msg.includes('unable to authenticate') ? 'GCM tag 不匹配（密钥不对）' : msg;
        failures.push(`${table}.${column} id=${id} :: ${tag}`);
        console.log(`    ${id.slice(0, 8)}…  ** 解密失败 **  ${tag}`);
        console.log(`        密文形态: ${shapeOf(raw)}`);
      }
    }
    console.log('');
  }

  console.log('='.repeat(78));
  console.log(`结果: ${totalOk} 行可解密，${failures.length} 行解密失败`);
  if (failures.length > 0) {
    console.log('失败清单（不含明文）:');
    for (const f of failures) console.log(`  - ${f}`);
    console.log('');
    console.log('判读: GCM tag 不匹配 ⇒ 这些行是用**另一个密钥**加密的。');
    console.log('      按 src/lib/crypto.ts 的迁移说明，需要设置');
    console.log('      ENCRYPTION_SECRET_PREVIOUS=<当初加密时用的那个值>（只参与解密）。');
  }
  console.log('='.repeat(78));
  return 0;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 1_500).unref(); })
  .catch((e: unknown) => { console.error('定位崩溃:', e); process.exitCode = 2; });
