/**
 * 只读诊断脚本：确认 Agent Workspace 产物链路在哪一步断了。
 * 不做任何写操作。
 */
import { getSupabaseClient } from '../src/storage/database/supabase-client';

const BUCKET = 'agent-artifacts';

function preview(value: string, max = 400): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

async function main() {
  const client = getSupabaseClient();

  console.log('=== 1. storage buckets ===');
  const buckets = await client.storage.listBuckets();
  if (buckets.error) console.log('  error:', buckets.error.message);
  else console.log('  ', buckets.data?.map((b) => `${b.name}${b.public ? ' (public)' : ' (private)'}`).join(', '));

  console.log(`\n=== 2. bucket "${BUCKET}" 内容 ===`);
  const root = await client.storage.from(BUCKET).list('', { limit: 20 });
  if (root.error) {
    console.log('  error:', root.error.message);
  } else if (!root.data || root.data.length === 0) {
    console.log('  空 —— 从未成功写入任何产物');
  } else {
    console.log('  顶层目录:', root.data.map((e) => e.name).join(', '));
    for (const tenant of root.data) {
      const biz = await client.storage.from(BUCKET).list(tenant.name, { limit: 20 });
      for (const b of biz.data ?? []) {
        const prefix = `${tenant.name}/${b.name}`;
        const arts = await client.storage.from(BUCKET).list(prefix, { limit: 50 });
        const ids = (arts.data ?? []).map((e) => e.name);
        console.log(`  ${prefix} -> ${ids.length} 个产物目录`);
        for (const id of ids.slice(0, 5)) {
          const files = await client.storage.from(BUCKET).list(`${prefix}/${id}`, { limit: 10 });
          console.log(`     ${id}: ${(files.data ?? []).map((f) => `${f.name}(${f.metadata?.size ?? '?'}B)`).join(', ')}`);
        }
      }
    }
  }

  console.log('\n=== 3. 最近 8 条 assistant 消息是否含产物标记 ===');
  const msgs = await client
    .from('chat_messages')
    .select('id, session_id, role, content, created_at')
    .eq('role', 'assistant')
    .order('created_at', { ascending: false })
    .limit(8);
  if (msgs.error) {
    console.log('  error:', msgs.error.message);
  } else {
    for (const m of msgs.data ?? []) {
      const content = (m.content as string) ?? '';
      const markers = content.match(/<<artifact:[0-9a-fA-F-]{36}>>/g) ?? [];
      const fences = content.match(/```artifact:/g) ?? [];
      console.log(
        `  ${String(m.created_at).slice(0, 19)} len=${content.length} markers=${markers.length} rawFences=${fences.length}`,
      );
      console.log(`     ${preview(content, 220)}`);
    }
  }

  console.log('\n=== 4. 是否有 pending 审批 ===');
  const approvals = await client
    .from('agent_approvals')
    .select('id, action_type, title, status, risk_level, created_at')
    .order('created_at', { ascending: false })
    .limit(6);
  if (approvals.error) console.log('  error:', approvals.error.message);
  else
    for (const a of approvals.data ?? []) {
      console.log(`  ${String(a.created_at).slice(0, 19)} [${a.status}] ${a.action_type} — ${preview(String(a.title), 80)}`);
    }

  console.log('\n=== 5. 已配置的模型（provider / model / 连接测试）===');
  const models = await client
    .from('model_configs')
    .select('provider, display_name, default_model, is_enabled, last_test_ok, last_test_error, models_cache')
    .limit(20);
  if (models.error) console.log('  error:', models.error.message);
  else
    for (const m of models.data ?? []) {
      const cache = Array.isArray(m.models_cache) ? m.models_cache.slice(0, 4).join('|') : '';
      console.log(
        `  ${m.provider} enabled=${m.is_enabled} default=${m.default_model} testOk=${m.last_test_ok} err=${preview(String(m.last_test_error ?? ''), 60)} cache=[${cache}]`,
      );
    }

  console.log('\n=== 6. model_assign ===');
  const settings = await client.from('settings').select('model_assign').limit(3);
  if (settings.error) console.log('  error:', settings.error.message);
  else for (const s of settings.data ?? []) console.log('  ', JSON.stringify(s.model_assign));

  console.log('\n=== 7. 最近 AI 调用账本（provider / model / status / 延迟）===');
  const ledger = await client
    .from('ai_usage_ledger')
    .select('provider, model, status, error_code, latency_ms, agent, created_at')
    .order('created_at', { ascending: false })
    .limit(12);
  if (ledger.error) console.log('  error:', ledger.error.message);
  else
    for (const r of ledger.data ?? []) {
      console.log(
        `  ${String(r.created_at).slice(0, 19)} ${String(r.provider).padEnd(10)} ${String(r.model).padEnd(28)} ${r.status} ${r.error_code ?? ''} ${r.latency_ms ?? '?'}ms agent=${r.agent ?? ''}`,
      );
    }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error('diagnostic failed:', error);
    process.exit(1);
  },
);
