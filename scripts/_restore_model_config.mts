/**
 * 一次性修复脚本：还原被测试覆盖的 model_configs 行。
 *
 * ## 背景（如实记录，不要删掉这段）
 *
 * 复现"保存不了"缺陷时，我写了一个直连 HTTP 的复现脚本，对**真实的 model_configs
 * 表**做了 POST —— 这不是只读探针。结果把 `custom` 这一行的配置整体覆盖成了测试值：
 *   api_key 从用户真实的 cpk-…9WRc 变成测试串、base_url 变成 .invalid 占位域名、
 *   display_name/timeout/retries/opt_in_local 全部被清掉。
 *
 * 密钥明文无法从掩码恢复，但它恰好也存在于 `docker/deploy.env`
 * （ROVEAGENT_LLM_API_KEY / ROVEFRAME_PLATFORM_LLM_API_KEY，后缀与覆盖前的掩码一致），
 * 因此可以完整还原。本脚本就是那次还原，保留下来是因为：
 *   1. 它记录了一次真实的事故与修法；
 *   2. "按 env 里的密钥还原某个 provider" 本身是可复用的运维动作。
 *
 * 用法（默认 dry-run，只有 --apply 才写）：
 *   npx tsx scripts/_restore_model_config.mts            # 只打印将要写什么
 *   npx tsx scripts/_restore_model_config.mts --apply
 */
import { readFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');

/** 在导入应用模块**之前**把 deploy.env 灌进 process.env（crypto 读 ENCRYPTION_SECRET）。 */
function loadEnv(): void {
  for (const rel of ['docker/deploy.env', 'scripts/deploy.env']) {
    let text: string;
    try { text = readFileSync(rel, 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); // override：与运行时一致
    }
  }
}
loadEnv();

const { encrypt, mask } = await import('../src/lib/crypto');
const { getSupabaseClient } = await import('../src/storage/database/supabase-client');

const TENANT = '00000000-0000-0000-0000-000000000000';
const BUSINESS = '00000000-0000-0000-0000-000000000001';

/** 覆盖前的值（来自复现脚本打印的 BEFORE 快照）。 */
const EXPECTED_MASK = 'cpk-****9WRc';
const RESTORE = {
  provider: 'custom',
  base_url: 'https://apihub.agnes-ai.com/v1',
  default_model: 'agnes-2.5-flash',
  display_name: 'agnes',
  timeout_ms: 300_000,
  max_retries: 4,
  opt_in_local: true,
  is_enabled: true,
  last_test_ok: true,
  last_tested_at: '2026-09-10T06:37:28.487+00:00',
  models_updated_at: '2026-09-10T06:37:28.487+00:00',
  models_cache: [
    'agnes-2.0-flash', 'agnes-image-2.0-flash', 'agnes-2.5-flash', 'agnes-video-2.5-flash',
    'agnes-3.0-flash', 'agnes-image-2.1-flash', 'agnes-video-v2.0', 'agnes-image-2.5-flash',
  ],
};

const key = process.env.ROVEAGENT_LLM_API_KEY ?? process.env.ROVEFRAME_PLATFORM_LLM_API_KEY ?? '';
if (!key.startsWith('cpk-') || key.slice(-4) !== '9WRc') {
  console.error('拒绝执行：deploy.env 里的 ROVEAGENT_LLM_API_KEY 不是被覆盖的那把（后缀应为 9WRc）');
  process.exit(2);
}
console.log(`来源密钥: prefix=${key.slice(0, 4)} suffix=...${key.slice(-4)} len=${key.length}`);
console.log(`按同一把密钥加密后的掩码应当等于: ${mask(key)}`);
console.log(`覆盖前的掩码（BEFORE 快照）      : ${EXPECTED_MASK}`);
console.log(`一致: ${mask(key) === EXPECTED_MASK ? 'YES' : 'NO —— 不要继续'}`);
if (mask(key) !== EXPECTED_MASK) process.exit(2);

const supabase = getSupabaseClient();

console.log('\n将要写入 model_configs:');
console.log(JSON.stringify({ ...RESTORE, api_key_encrypted: '<encrypted>' }, null, 2));

// 清理我在复现时新建的测试行
const TEST_PROVIDER = 'openai';
const { data: testRow } = await supabase.from('model_configs').select('id, display_name')
  .eq('tenant_id', TENANT).eq('business_id', BUSINESS).eq('provider', TEST_PROVIDER).maybeSingle();
if (testRow && testRow.display_name === 'Repro') {
  console.log(`\n将删除复现遗留的测试行: provider=${TEST_PROVIDER} id=${testRow.id}`);
} else if (testRow) {
  console.log(`\n注意: ${TEST_PROVIDER} 已存在但 display_name=${testRow.display_name}，不是我的测试行，不动它`);
}

if (!APPLY) {
  console.log('\nDRY RUN：未写入。加 --apply 执行。');
  process.exit(0);
}

const { error } = await supabase.from('model_configs')
  .update({ ...RESTORE, api_key_encrypted: encrypt(key) })
  .eq('tenant_id', TENANT).eq('business_id', BUSINESS).eq('provider', 'custom');
if (error) { console.error('还原失败:', error.message); process.exit(1); }

if (testRow && testRow.display_name === 'Repro') {
  const { error: delErr } = await supabase.from('model_configs').delete()
    .eq('id', testRow.id).eq('tenant_id', TENANT).eq('business_id', BUSINESS);
  if (delErr) console.error('删除测试行失败:', delErr.message);
  else console.log('已删除复现遗留的测试行');
}

// 复核：读回并比对掩码
const { data: after } = await supabase.from('model_configs')
  .select('provider, api_key_encrypted, base_url, default_model, display_name, opt_in_local, timeout_ms, max_retries')
  .eq('tenant_id', TENANT).eq('business_id', BUSINESS).eq('provider', 'custom').maybeSingle();
const maskAfter = after?.api_key_encrypted ? mask((await import('../src/lib/crypto')).decrypt(after.api_key_encrypted)) : '(none)';
console.log('\n还原后读回:');
console.log(`  base_url      = ${after?.base_url}`);
console.log(`  default_model = ${after?.default_model}`);
console.log(`  display_name  = ${after?.display_name}`);
console.log(`  maskedKey     = ${maskAfter}`);
console.log(`  optInLocal    = ${after?.opt_in_local}  timeout=${after?.timeout_ms}  retries=${after?.max_retries}`);
console.log(`\n掩码与覆盖前一致: ${maskAfter === EXPECTED_MASK ? 'YES —— 已完整还原' : 'NO —— 仍需人工处理'}`);
