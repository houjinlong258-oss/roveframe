/**
 * 端到端验收：通过应用 AI Router 真实调用 DeepSeek。
 * 链路覆盖：settings.model_assign 路由解析 → model_configs 读取+解密 → DeepSeek 真实调用 → ai_usage_ledger 记账。
 * 用法: pnpm tsx scripts/e2e-deepseek-router.ts（需 .env 已配置 Supabase 三键 + ENCRYPTION_SECRET）
 */
import 'dotenv/config';
import { peekAIRoute, invokeChat } from '@/lib/ai/router';

const TENANT = '00000000-0000-0000-0000-000000000000';
const BUSINESS = '00000000-0000-0000-0000-000000000001';

async function main() {
  const requestId = crypto.randomUUID();
  const scope = { tenantId: TENANT, businessId: BUSINESS, requestId };

  const route = await peekAIRoute('content', scope);
  console.log('route:', JSON.stringify(route));

  const t0 = Date.now();
  const text = await invokeChat(
    'content',
    [{ role: 'user', content: '用一句中文介绍"四川人家"餐厅的招牌菜，不超过40字。' }],
    undefined,
    scope,
    { agent: 'acceptance-test', timeoutMs: 30000 },
  );
  console.log('latency_ms:', Date.now() - t0);
  console.log('output:', text);
  console.log('request_id:', requestId);
}

main().catch((err) => {
  console.error('E2E FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(2);
});
