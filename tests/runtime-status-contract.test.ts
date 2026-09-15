/**
 * Step 3 验证：请求分类（task 2 的核心判定逻辑）。
 *
 * 这个分类决定「Runtime 挂掉时能不能降级」：
 * - chat         → 允许 TS 兜底（但要显示 fallback 徽标）
 * - tool_execution → 禁止降级，必须失败并显示 unavailable
 *
 * 误判的代价不对称：
 * - 把 tool_execution 误判成 chat ⇒ 用户以为文件改了，实际没改（严重）
 * - 把 chat 误判成 tool_execution ⇒ 普通问答无谓失败（体验差但不危险）
 * 因此规则偏保守：只匹配**动作意图**，不匹配名词性提及。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyRequest } from '../src/lib/agent/request-class';

test('明确的工具动作被判为 tool_execution', () => {
  const cases: Array<[string, string]> = [
    ['please read the README file', 'file'],
    ['帮我把 src/app/api/agent/chat/route.ts 改一下', 'file'],
    ['read_file 一下配置', 'file'],
    ['run the tests', 'terminal'],
    ['执行一下迁移脚本', 'terminal'],
    ['ssh 到服务器看看', 'terminal'],
    ['restart the service', 'process'],
    ['重启一下服务', 'process'],
    ['deploy the app to production', 'deploy'],
    ['部署应用到生产', 'deploy'],
    ['generate an image of a poster', 'media'],
    ['生成一张海报', 'media'],
    ['做一个视频', 'media'],
    ['enable the plugin', 'plugin'],
    ['安装插件', 'plugin'],
  ];
  for (const [message, expected] of cases) {
    const result = classifyRequest(message);
    assert.equal(result.requestClass, 'tool_execution', `未识别为工具类：${message}`);
    assert.equal(result.intent, expected, `意图不符：${message}`);
  }
});

test('普通问答判为 chat', () => {
  const cases = [
    '你好',
    '今天营收多少？',
    '分析一下最近的差评趋势',
    '给我一份本周经营总结',
    '客户流失率怎么样',
    '帮我写一段营销文案',
    'What is our revenue this week?',
    'Summarize the negative reviews',
    'How are customers churning?',
  ];
  for (const message of cases) {
    assert.equal(
      classifyRequest(message).requestClass,
      'chat',
      `被误判为工具类：${message}`,
    );
  }
});

test('分类是确定性的（同输入同输出）', () => {
  const message = 'please read the README file';
  const first = classifyRequest(message);
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(classifyRequest(message), first);
  }
});

test('空输入与空白输入判为 chat（不误触工具类）', () => {
  for (const message of ['', '   ', '\n\t']) {
    const result = classifyRequest(message);
    assert.equal(result.requestClass, 'chat');
    assert.equal(result.intent, null);
  }
});

test('命中片段被记录（供审计），且长度受限', () => {
  const result = classifyRequest('please read the README file carefully');
  assert.equal(result.requestClass, 'tool_execution');
  assert.ok(result.matched, 'matched 不应为空');
  assert.ok(result.matched!.length <= 80, 'matched 应被截断到 80 字符以内');
});

test('chat 分类不带 intent / matched', () => {
  const result = classifyRequest('今天营收多少？');
  assert.equal(result.requestClass, 'chat');
  assert.equal(result.intent, null);
  assert.equal(result.matched, null);
});

test('undici 风格的源码文件名会被识别为 file 意图', () => {
  // 文件名形态是最可靠的「要动代码」信号
  for (const message of [
    '看看 package.json',
    '解释一下 schema.ts',
    '检查 migrate-runtime-metadata.sql',
  ]) {
    const result = classifyRequest(message);
    assert.equal(result.requestClass, 'tool_execution', `未识别：${message}`);
    assert.equal(result.intent, 'file');
  }
});
