/**
 * 一次性验收脚本：用应用自身 connection-test 代码路径测试 DeepSeek 真实连通。
 * 用法: pnpm tsx scripts/test-deepseek-connection.ts
 * 密钥从环境变量 DEEPSEEK_TEST_KEY 读入，不硬编码、不落盘。
 */
import { testProviderConnection } from '@/lib/ai/connection-test';

async function main() {
  const apiKey = process.env.DEEPSEEK_TEST_KEY;
  if (!apiKey) {
    console.error('DEEPSEEK_TEST_KEY not set');
    process.exit(1);
  }
  const result = await testProviderConnection({
    provider: 'deepseek',
    apiKey,
    model: 'deepseek-v4-flash',
    timeoutMs: 20000,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 2);
}

main();
