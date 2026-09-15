/**
 * Step 3 结构不变量测试。
 *
 * 为什么用源码断言：`/api/agent/chat` 路由需要 Supabase 凭据 + 登录态才能
 * 真正跑起来（本机无 `.env`），因此「Runtime 不可用时工具类请求必须硬失败」
 * 这条最关键的安全不变式无法用运行时测试覆盖。
 *
 * 这些断言是**护栏**：它们不证明逻辑正确，但能保证有人删掉那个 return
 * 或把分类判断接错时，CI 会红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const routeSource = readFileSync(
  path.join(repoRoot, 'src', 'app', 'api', 'agent', 'chat', 'route.ts'),
  'utf8',
);

test('工具类请求 + Runtime 不可用 ⇒ 硬失败（unavailable 分支必须 return）', () => {
  assert.match(routeSource, /runtimeStatus\.mode === 'unavailable'/, '缺少 unavailable 分支判断');
  // 该分支内必须 emit error 且 return，不得继续走 TS 兜底
  const idx = routeSource.indexOf("runtimeStatus.mode === 'unavailable'");
  assert.ok(idx > 0, 'unavailable 分支不存在');
  const branch = routeSource.slice(idx, idx + 2600);
  assert.match(branch, /runtime_unavailable/, 'unavailable 分支未发出 runtime_unavailable 错误');
  assert.match(branch, /\breturn\b/, 'unavailable 分支缺少 return —— 会继续降级！');
  assert.match(branch, /runtime_required_for_tool_task/, 'unavailable 分支缺少用户可见 notice');
});

test('分类在 Runtime 调用之前完成（否则无法决定是否降级）', () => {
  const classifyIdx = routeSource.indexOf('const classification = classifyRequest(');
  const callIdx = routeSource.indexOf('roveAgentStream = roveAgentChatStream(');
  assert.ok(classifyIdx > 0, '缺少 classifyRequest 调用');
  assert.ok(callIdx > 0, '缺少 roveAgentChatStream 调用');
  assert.ok(classifyIdx < callIdx, '分类必须早于 Runtime 调用');
});

test('chat 类请求仍允许 fallback（不得被 unavailable 分支拦掉）', () => {
  const idx = routeSource.indexOf('if (roveAgentConfigured())');
  assert.ok(idx > 0);
  const block = routeSource.slice(idx, idx + 2000);
  assert.match(block, /classification\.requestClass === 'tool_execution'/, '缺少按分类分流');
  assert.match(block, /mode: 'fallback'/, 'chat 类应保留 fallback 路径');
});

test('runtime_status 事件在流最开始发出（先于任何内容）', () => {
  const statusIdx = routeSource.indexOf("emit({ type: 'runtime_status'");
  const thinkIdx = routeSource.indexOf("emit({ type: 'status', phase: 'thinking' })");
  const deltaIdx = routeSource.indexOf("emit({ type: 'delta'");
  assert.ok(statusIdx > 0, '缺少 runtime_status emit');
  if (thinkIdx > 0) assert.ok(statusIdx < thinkIdx + 200, 'runtime_status 应紧邻流开始处');
  assert.ok(deltaIdx > 0);
  assert.ok(statusIdx < deltaIdx, 'runtime_status 必须先于任何 delta');
});

test('session runtime 元数据被写入且带降级容错', () => {
  assert.match(routeSource, /runtime_mode: runtimeStatus\.mode/, '未持久化 runtime_mode');
  assert.match(routeSource, /runtime_agent:/, '未持久化 runtime_agent');
  assert.match(routeSource, /runtime_request_class: classification\.requestClass/, '未持久化请求分类');
  assert.match(routeSource, /runtime_tool_intent: classification\.intent/, '未持久化工具意图');
  assert.match(routeSource, /runtime_at:/, '未持久化时间戳');
  // 关键：列不存在时不能连带把 updated_at 更新也丢掉
  assert.match(routeSource, /withMeta\.error/, '缺少元数据写入失败的回退分支');
  assert.match(routeSource, /fallbackUpdate/, '缺少仅更新 updated_at 的回退');
});

test('迁移脚本存在且幂等（ADD COLUMN IF NOT EXISTS）', () => {
  const sql = readFileSync(
    path.join(repoRoot, 'scripts', 'migrate-runtime-metadata.sql'),
    'utf8',
  );
  for (const column of [
    'runtime_mode', 'runtime_agent', 'runtime_request_class',
    'runtime_tool_intent', 'runtime_at',
  ]) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}\\b`),
      `迁移脚本缺少 ${column} 或不是幂等写法`);
  }
});

test('schema.ts 已声明 runtime 元数据列', () => {
  const schema = readFileSync(
    path.join(repoRoot, 'src', 'storage', 'database', 'shared', 'schema.ts'),
    'utf8',
  );
  for (const column of [
    'runtime_mode', 'runtime_agent', 'runtime_request_class',
    'runtime_tool_intent', 'runtime_at',
  ]) {
    assert.match(schema, new RegExp(`${column}: varchar\\(|${column}: timestamp\\(`),
      `schema.ts 缺少 ${column}`);
  }
});

/* -------------------------------------------------------------------------- */
/* Step 3.1：runtime-health 代理路由的不变量                                     */
/* -------------------------------------------------------------------------- */

const healthRouteSource = readFileSync(
  path.join(repoRoot, 'src', 'app', 'api', 'agent', 'runtime-health', 'route.ts'),
  'utf8',
);

test('runtime-health 路由对未登录返回 401（不泄露 Runtime 拓扑）', () => {
  assert.match(healthRouteSource, /getTenantContext\(request\)/, '缺少鉴权调用');
  assert.match(healthRouteSource, /errorResponse\(error, 401\)/, '未登录应回 401');
});

test('runtime-health 用 200 表达「Runtime 不可用」（不是 5xx）', () => {
  // 用 5xx 会让前端把「Runtime 挂了」和「本路由自己出错」混为一谈
  assert.match(healthRouteSource, /ok: health\.ok/, '未回传 ok 字段');
  assert.doesNotMatch(healthRouteSource, /status:\s*5\d\d/, '不得用 5xx 表达 Runtime 不可用');
  assert.doesNotMatch(healthRouteSource, /status:\s*4\d\d(?!\s*\))/, '不得用 4xx 表达 Runtime 不可用');
});

test('runtime-health 不得下发凭据（只回脱敏结论）', () => {
  for (const leak of ['apiKey', 'api_key', 'ROVEAGENT_API_KEY:', 'Authorization']) {
    assert.ok(
      !healthRouteSource.includes(leak),
      `响应体疑似泄露凭据字段：${leak}`,
    );
  }
});

test('runtime-health 禁止缓存（探测必须实时）', () => {
  assert.match(healthRouteSource, /'Cache-Control':\s*'no-store'/);
  assert.match(healthRouteSource, /force-dynamic/);
});

test('前端不得把 roveagent client 引入客户端组件（node:crypto 依赖）', () => {
  // client.ts → signature.ts → node:crypto，被 'use client' 组件引入会打包失败
  const pageSource = readFileSync(
    path.join(repoRoot, 'src', 'app', '[locale]', 'agent', 'page.tsx'),
    'utf8',
  );
  const statusStrip = readFileSync(
    path.join(repoRoot, 'src', 'components', 'agent', 'status-strip.tsx'),
    'utf8',
  );
  for (const [name, source] of [['page.tsx', pageSource], ['status-strip.tsx', statusStrip]] as const) {
    assert.ok(
      !source.includes("from '@/lib/roveagent/client'"),
      `${name} 引入了 @/lib/roveagent/client —— 会拖入 node:crypto`,
    );
  }
});

test('task2：状态条在 roveagent 模式下必须返回 null（不渲染）', () => {
  const statusStrip = readFileSync(
    path.join(repoRoot, 'src', 'components', 'agent', 'status-strip.tsx'),
    'utf8',
  );
  assert.match(statusStrip, /if \(!view\.visible\) return null;/, '缺少「不可见即返回 null」守卫');
  assert.match(statusStrip, /presentRuntime\(/, '展示决策必须走 presentRuntime 纯函数');
});
