/**
 * Phase 15 — 诊断：CJS 互操作下模块导出的真实形状（只读）。
 *
 * `src/lib/agent/approvals.ts` 的 `requestApproval` 在 ESM 命名空间导入下取不到，
 * 报 "available: default, module.exports"。本脚本打印真实形状，避免猜测。
 */
import * as approvals from '../src/lib/agent/approvals';
import * as bootCheck from '../src/lib/boot-check';
import * as supabaseClient from '../src/storage/database/supabase-client';

function describe(label: string, mod: unknown): void {
  const m = mod as Record<string, unknown>;
  console.log(`--- ${label} ---`);
  const keys = Object.keys(m);
  console.log(`  namespace keys (${keys.length}): ${JSON.stringify(keys.slice(0, 20))}`);
  const d = m.default as Record<string, unknown> | undefined;
  console.log(`  typeof default: ${typeof m.default}`);
  if (d && typeof d === 'object') {
    const dk = Object.keys(d);
    console.log(`  default keys (${dk.length}): ${JSON.stringify(dk.slice(0, 30))}`);
    console.log(`  default.requestApproval: ${typeof d.requestApproval}`);
    console.log(`  default.runBootChecks: ${typeof d.runBootChecks}`);
  }
  console.log(`  namespace.requestApproval: ${typeof m.requestApproval}`);
  console.log('');
}

describe('src/lib/agent/approvals', approvals);
describe('src/lib/boot-check', bootCheck);
describe('src/storage/database/supabase-client', supabaseClient);
