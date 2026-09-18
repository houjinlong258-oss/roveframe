/**
 * Phase 15 — 独立复核子代理审计中的高危结论（只读，查真实库）。
 *
 * 子代理是**读代码**得出的结论。以下几条如果为真，严重度很高，
 * 因此必须用真实库/真实代码交叉验证，不能直接采信：
 *
 *   1. `ROVEAGENT_COMMAND_POLICY=enforce` 是否设置 —— 若未设置，
 *      CTO persona 的真实 shell 只被"记录"而不被阻止（HIGH 风险）。
 *   2. `registerDefaultTools`（解耦工具）是否真的零调用方 —— 死代码。
 *   3. `purchase_orders` 表是否真的没有任何代码读写 —— 采购闭环是否存在。
 *   4. 审批默认值：createPendingApproval 的 risk/required_role 默认是否为 medium/manager。
 */
import * as supabaseModule from '../src/storage/database/supabase-client';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

type Res = { data: unknown[] | null; error: { message: string } | null };

const getSupabaseClient = (supabaseModule as unknown as { getSupabaseClient?: () => unknown }).getSupabaseClient
  ?? (supabaseModule as unknown as { default?: { getSupabaseClient?: () => unknown } }).default?.getSupabaseClient;
if (!getSupabaseClient) throw new Error('getSupabaseClient not resolvable');

const ROOT = process.cwd();

/** 递归收集 src 下的 .ts/.tsx 源文件 */
function srcFiles(dir = join(ROOT, 'src')): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...srcFiles(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

function countOccurrences(re: RegExp): { total: number; hits: string[] } {
  const hits: string[] = [];
  let total = 0;
  for (const f of srcFiles()) {
    const text = readFileSync(f, 'utf8');
    const m = text.match(re);
    if (m) {
      total += m.length;
      for (const _ of m) hits.push(f.replace(ROOT + '\\', '').replace(/\\/g, '/'));
    }
  }
  return { total, hits: [...new Set(hits)] };
}

async function main(): Promise<number> {
  console.log('='.repeat(86));
  console.log('Phase 15 — 高危结论独立复核（只读）');
  console.log('='.repeat(86));

  // ---- 1. ROVEAGENT_COMMAND_POLICY ----------------------------------------
  console.log('');
  console.log('[1] ROVEAGENT_COMMAND_POLICY 是否被设置（enforce 才真正阻止命令）');
  const policy = process.env.ROVEAGENT_COMMAND_POLICY;
  console.log(`    宿主环境: ${policy === undefined ? '**未设置**' : JSON.stringify(policy)}`);
  const { total: policyRefs, hits: policyFiles } = countOccurrences(/ROVEAGENT_COMMAND_POLICY/g);
  console.log(`    仓库中引用次数: ${policyRefs}（文件: ${policyFiles.join(', ') || '无'}）`);

  // ---- 2. registerDefaultTools 是否有调用方 --------------------------------
  console.log('');
  console.log('[2] registerDefaultTools（解耦工具注册）是否有调用方');
  const { total: regRefs, hits: regFiles } = countOccurrences(/registerDefaultTools/g);
  console.log(`    出现次数: ${regRefs}`);
  console.log(`    出现的文件: ${regFiles.join(', ') || '无'}`);
  const callSites = regFiles.filter((f) => !f.includes('tools/index.ts') && !f.startsWith('tests/'));
  console.log(`    非定义处、非测试的调用点: ${callSites.length === 0 ? '**无**（死代码）' : callSites.join(', ')}`);

  // ---- 3. purchase_orders 是否被读写 --------------------------------------
  console.log('');
  console.log('[3] purchase_orders 是否真的没有任何代码读写');
  const { total: poRefs, hits: poFiles } = countOccurrences(/purchase_orders/g);
  console.log(`    src 下出现次数: ${poRefs}（文件: ${poFiles.join(', ') || '无'}）`);
  const client = getSupabaseClient!() as unknown as {
    from(t: string): { select(c: string, o?: unknown): { limit(n: number): Promise<Res> } };
  };
  const { data: poRows, error: poErr } = await client.from('purchase_orders').select('*').limit(50);
  if (poErr) {
    console.log(`    真实库读取失败: ${poErr.message}`);
  } else {
    console.log(`    真实库行数: ${(poRows ?? []).length}`);
  }
  const { data: invRows } = await client.from('inventory_items').select('id, name, supplier').limit(200);
  console.log(`    inventory_items 行数: ${(invRows ?? []).length}（审批执行写的是这张表，不是 purchase_orders）`);

  // ---- 4. 审批默认值 ------------------------------------------------------
  console.log('');
  console.log('[4] createPendingApproval 的默认 risk / required_role');
  const approvalsSrc = readFileSync(join(ROOT, 'src/lib/agent/approvals.ts'), 'utf8');
  const riskDefault = approvalsSrc.match(/risk_level:\s*opts\.riskLevel\s*\?\?\s*'([a-z]+)'/);
  const roleDefault = approvalsSrc.match(/required_role:\s*opts\.requiredRole\s*\?\?\s*'([a-z]+)'/);
  console.log(`    risk_level 默认: ${riskDefault ? riskDefault[1] : '(未匹配到)'}`);
  console.log(`    required_role 默认: ${roleDefault ? roleDefault[1] : '(未匹配到)'}`);

  // ---- 5. 复核：UI 是否绕过审批直接写 --------------------------------------
  console.log('');
  console.log('[5] UI 直达写入（绕过审批闭环）的路径');
  for (const [label, file, re] of [
    ['reviews 页 AI 起草/发布', 'src/app/[locale]/reviews/page.tsx', /\/api\/reviews/g],
    ['reviews reply 路由', 'src/app/api/reviews/reply/route.ts', /reply_content|reply_status/g],
    ['channels/send 路由', 'src/app/api/channels/send/route.ts', /sendChannelMessage|insert/g],
  ] as const) {
    try {
      const text = readFileSync(join(ROOT, file), 'utf8');
      const n = (text.match(re) ?? []).length;
      console.log(`    ${label.padEnd(28)} 匹配 ${n} 处  (${file})`);
    } catch {
      console.log(`    ${label.padEnd(28)} 文件不存在: ${file}`);
    }
  }

  console.log('');
  console.log('='.repeat(86));
  return 0;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 800).unref(); })
  .catch((e: unknown) => { console.error('崩溃:', e); process.exitCode = 2; });
