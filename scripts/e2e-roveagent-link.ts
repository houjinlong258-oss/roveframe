/**
 * TS↔Python 链路真实验证：RoveFrame 客户端 → RoveAgent Service。
 * 运行：ROVEAGENT_API_URL=... ROVEAGENT_API_KEY=... pnpm exec tsx scripts/e2e-roveagent-link.ts
 */
import {
  roveAgentChat, roveAgentConfigured, roveAgentCreateSkill,
  roveAgentCreateTask, roveAgentExecuteTask, roveAgentMemory, roveAgentTaskStatus,
} from '../src/lib/roveagent/client';
import { randomUUID } from 'node:crypto';

async function main() {
  console.log('configured:', roveAgentConfigured());
  const tenantId = 'demo-restaurant';
  const businessId = 'demo-location';
  const userId = 'demo-owner';

  // 1. task：中文目标 → 目标引擎拆解
  const created = await roveAgentCreateTask(tenantId, businessId, '月营收提升 15%');
  console.log('1. task OK:', created.task.status, '| metric:', created.metric, '| target:', created.target,
    '| steps:', created.task.steps.length);

  // 2. status
  const status = await roveAgentTaskStatus(tenantId, businessId, created.task.id);
  console.log('2. status OK:', status.task.status);

  // 3. execute（审批）
  const exec1 = await roveAgentExecuteTask(tenantId, businessId, created.task.id, false);
  const exec2 = await roveAgentExecuteTask(tenantId, businessId, created.task.id, true, 'owner');
  console.log('3. execute OK:', exec1.status, '->', exec2.status);

  // 4. memory
  const mem = await roveAgentMemory(tenantId, businessId, '营收');
  console.log('4. memory OK:', mem.count, 'hits');

  // 5. skill/create
  const skill = await roveAgentCreateSkill({
    tenantId, businessId, name: 'weekend-promo', description: '周末促销 SOP',
    workflow: '1.选品 2.定价 3.推送', industry: 'restaurant',
  });
  console.log('5. skill OK:', skill.path);

  // 6. chat：未配 LLM 时应返回 503（证明请求到达 Python 且不伪造回答）
  try {
    const chat = await roveAgentChat({
      tenantId,
      businessId,
      userId,
      message: '本周销售为什么下降？',
      role: 'owner',
      permissions: ['*'],
      requestId: randomUUID(),
      taskId: randomUUID(),
      sessionId: randomUUID(),
      industry: 'restaurant',
      businessContext: 'Current canonical business facts: test fixture.',
    });
    console.log('6. chat OK (LLM configured):', chat.reply.slice(0, 40));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('503')) console.log('6. chat OK: reached Python, 503 as expected (no LLM key)');
    else throw e;
  }
  console.log('=== TS<->PYTHON LINK VERIFIED ===');
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
