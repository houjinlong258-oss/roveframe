/**
 * Phase 15 — 确认 model_assign 指向哪个 provider（只读，不打印密钥）。
 *
 * 目的：把"两行 model_configs 只能用历史密钥解密"与
 * "[agent/chat] memory extraction failed: API key is required" 对上。
 *
 * memory 沉淀走 `invokeChat('light', …)`（见 src/app/api/agent/chat/route.ts 的
 * extractAndStoreMemory）。'light' 在 settings.model_assign 里指向哪个
 * provider:model，决定了它会不会去读 model_configs 并解密 api_key_encrypted。
 */
import * as supabaseModule from '../src/storage/database/supabase-client';

type Row = Record<string, unknown>;
type Res = { data: Row[] | null; error: { message: string } | null };

const getSupabaseClient = (supabaseModule as unknown as { getSupabaseClient?: () => unknown }).getSupabaseClient
  ?? (supabaseModule as unknown as { default?: { getSupabaseClient?: () => unknown } }).default?.getSupabaseClient;
if (!getSupabaseClient) throw new Error('getSupabaseClient not resolvable');

async function main(): Promise<number> {
  const client = getSupabaseClient!();
  const q = (t: string, c: string): Promise<Res> =>
    (client as { from(x: string): { select(c: string): { limit(n: number): Promise<Res> } } })
      .from(t).select(c).limit(20);

  console.log('='.repeat(78));
  console.log('Phase 15 — model_assign 与 provider 配置核对（不打印密钥）');
  console.log('='.repeat(78));
  console.log('');

  const { data: settingsRows, error: se } = await q('settings', 'tenant_id, business_id, model_assign, locale');
  if (se) { console.log(`settings 读取失败: ${se.message}`); return 2; }
  for (const s of settingsRows ?? []) {
    console.log(`[settings] tenant=${String(s.tenant_id).slice(0, 8)}… business=${String(s.business_id).slice(0, 8)}…`);
    console.log(`    model_assign = ${JSON.stringify(s.model_assign)}`);
  }
  console.log('');

  const { data: cfgs, error: ce } = await q(
    'model_configs',
    'id, provider, display_name, default_model, is_enabled, base_url, tenant_id, business_id, api_key_encrypted',
  );
  if (ce) { console.log(`model_configs 读取失败: ${ce.message}`); return 2; }
  console.log(`[model_configs] ${(cfgs ?? []).length} 行:`);
  for (const c of cfgs ?? []) {
    console.log(`    id=${String(c.id).slice(0, 8)}…  provider=${String(c.provider)}  model=${String(c.default_model)}`);
    console.log(`        is_enabled=${String(c.is_enabled)}  tenant=${String(c.tenant_id).slice(0, 8)}… business=${String(c.business_id).slice(0, 8)}…`);
    console.log(`        base_url=${String(c.base_url ?? '(null)')}`);
    console.log(`        api_key_encrypted 存在=${c.api_key_encrypted !== null && c.api_key_encrypted !== undefined}`);
  }
  console.log('');

  console.log('='.repeat(78));
  console.log('判读: 若 model_assign 的某个能力指向上面这些 provider，且其 api_key_encrypted');
  console.log('      只能用历史密钥解密，则该能力的调用会解密失败 —— 与日志一致。');
  console.log('='.repeat(78));
  return 0;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 1_500).unref(); })
  .catch((e: unknown) => { console.error('核对崩溃:', e); process.exitCode = 2; });
