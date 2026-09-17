/**
 * Phase 15 — settings 行与 tenant 归属（只读）。
 *
 * 目的：确认新注册 tenant 是否存在 settings 行、其 model_assign 是什么。
 * 这决定了 `resolveModelDetailed` 走"外部 provider"还是"平台内置"分支，
 * 从而解释 "[agent/chat] memory extraction failed: API key is required"。
 */
import * as supabaseModule from '../src/storage/database/supabase-client';

type Row = Record<string, unknown>;
type Res = { data: Row[] | null; error: { message: string } | null };

const getSupabaseClient = (supabaseModule as unknown as { getSupabaseClient?: () => unknown }).getSupabaseClient
  ?? (supabaseModule as unknown as { default?: { getSupabaseClient?: () => unknown } }).default?.getSupabaseClient;
if (!getSupabaseClient) throw new Error('getSupabaseClient not resolvable');

async function main(): Promise<number> {
  const client = getSupabaseClient!();
  const sel = (t: string, c: string): Promise<Res> =>
    (client as { from(x: string): { select(c: string): { limit(n: number): Promise<Res> } } })
      .from(t).select(c).limit(50);

  const { data: tenants } = await sel('tenants', 'id, name, created_at');
  const { data: settings } = await sel('settings', 'tenant_id, business_id, model_assign, locale');

  console.log('='.repeat(76));
  console.log('Phase 15 — settings 与 tenant 归属对照');
  console.log('='.repeat(76));
  console.log(`tenants ${(tenants ?? []).length} 行，settings ${(settings ?? []).length} 行`);
  console.log('');

  const byTenant = new Map<string, Row[]>();
  for (const s of settings ?? []) {
    const k = String(s.tenant_id);
    if (!byTenant.has(k)) byTenant.set(k, []);
    byTenant.get(k)!.push(s);
  }

  for (const t of tenants ?? []) {
    const id = String(t.id);
    const rows = byTenant.get(id) ?? [];
    const assign = rows.length ? JSON.stringify(rows[0].model_assign) : '(无 settings 行 → model_assign 视为 auto)';
    console.log(`  ${id.slice(0, 8)}…  ${String(t.name).padEnd(28)} settings=${rows.length}  assign=${assign}`);
  }

  console.log('');
  console.log('='.repeat(76));
  console.log('判读: 无 settings 行或 assign 非 "provider:model" 时，router 走平台内置分支，');
  console.log('      该分支不携带 apiKey，本环境未配置平台密钥 → "API key is required"。');
  console.log('='.repeat(76));
  return 0;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 1_500).unref(); })
  .catch((e: unknown) => { console.error('崩溃:', e); process.exitCode = 2; });
