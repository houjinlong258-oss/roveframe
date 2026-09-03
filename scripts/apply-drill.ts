/**
 * Apply Engine 真实端到端演练（一次性脚本，不属于测试套件）
 * 提案 → 批准 → apply（worktree 隔离写入 + 测试门禁 + merge）→ 验证 → rollback → 验证
 */
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import {
  saveProposal,
  getProposalById,
  updateProposalStatus,
} from '../src/lib/coding-agent/persistent-store';
import { applyProposal, rollbackProposal } from '../src/lib/coding-agent/apply-engine';
import type { CodingProposal } from '../src/lib/coding-agent/types';

const TENANT = 'tenant_drill';
const ACTOR = { userId: 'user_drill', tenantId: TENANT };
const TARGET = 'src/custom/widgets/apply-drill.ts';
const ID = `cprop_drill_${Date.now().toString(36)}`;

async function main() {
  console.log('=== 1. 创建提案（内存回退模式） ===');
  const proposal: CodingProposal = {
    id: ID,
    taskId: `task_drill`,
    status: 'pending_review',
    title: 'Drill: add apply-drill widget helper',
    summary: '端到端演练：在 src/custom/ 下新增一个无害的工具函数文件',
    changes: [
      {
        filePath: TARGET,
        operation: 'create',
        proposedContent:
          '/** Apply Engine 端到端演练产物 — 可安全删除 */\nexport const APPLY_DRILL_OK = true;\n',
        rationale: '验证 apply engine 的 worktree 写入 + 测试门禁 + 合入链路',
      },
    ],
    riskLevel: 'safe',
    requiresHumanApproval: true,
    blockedPaths: [],
    generatedAt: new Date().toISOString(),
  };
  await saveProposal(proposal, TENANT);
  console.log('saved:', ID);

  console.log('=== 2. 人工批准 ===');
  const approved = await updateProposalStatus(ID, 'approved', TENANT, {
    decidedBy: ACTOR.userId,
    decidedAt: new Date().toISOString(),
  });
  console.log('status:', approved?.status);
  if (approved?.status !== 'approved') throw new Error('approve failed');

  console.log('=== 3. Apply（worktree → merge → 测试门禁） ===');
  const headBefore = execSync('git rev-parse HEAD').toString().trim();
  const result = await applyProposal(ID, ACTOR);
  console.log(result.log);
  if (!result.ok) throw new Error('apply failed');
  console.log('commitSha:', result.commitSha);

  console.log('=== 4. 验证落地 ===');
  console.log('文件存在:', existsSync(TARGET));
  const log = execSync('git log --oneline -3').toString();
  console.log('git log:\n' + log);
  const after = await getProposalById(ID, TENANT);
  console.log('提案状态:', after?.status, '| appliedCommitSha:', after?.appliedCommitSha?.slice(0, 8));
  if (!existsSync(TARGET) || after?.status !== 'applied') throw new Error('verify failed');

  console.log('=== 5. Rollback（git revert） ===');
  const rb = await rollbackProposal(ID, ACTOR);
  console.log(rb.log);
  if (!rb.ok) throw new Error('rollback failed');
  console.log('文件已移除:', !existsSync(TARGET));
  const final = await getProposalById(ID, TENANT);
  console.log('最终状态:', final?.status, '| rollbackCommitSha:', final?.rollbackCommitSha?.slice(0, 8));
  if (existsSync(TARGET) || final?.status !== 'rolled_back') throw new Error('rollback verify failed');

  const headAfter = execSync('git rev-parse HEAD').toString().trim();
  console.log('=== 6. 结果 ===');
  console.log('HEAD 前进:', headBefore.slice(0, 8), '→', headAfter.slice(0, 8), '(审批轨迹保留在 git 历史)');
  console.log('DRILL OK');
}

main().catch((e) => {
  console.error('DRILL FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
