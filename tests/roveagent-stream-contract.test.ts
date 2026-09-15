/**
 * 跨语言 SSE 契约测试（Step 2）。
 *
 * 背景：Python 内核产出 SSE 事件，TypeScript 前端消费。
 * `use-sse.ts` 的 `KNOWN_EVENT_TYPES` 是**白名单** —— 名字对不上就被静默丢弃。
 * 这类漂移在生产里表现为「AI 不说话」，而且没有任何报错。
 *
 * 本测试不启动 Python、不连数据库：它直接读两侧的**源码文本**，断言事件名集合一致。
 * 这是防漂移护栏，不是集成测试。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { KNOWN_EVENT_TYPES } from '../src/hooks/use-sse';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

/**
 * Python 侧 stream_wire.py 产出的所有事件类型名。
 *
 * 提取方式：扫描 `"type": "<name>"` 字面量。不用 `_event({...})` 匹配，
 * 因为多数构造器先把字段装进变量再传入 `_event(payload)`，
 * 按调用形态匹配会漏掉它们（初版就漏到只剩 2 个）。
 */
function pythonEventTypes(): Set<string> {
  const source = readFileSync(
    path.join(repoRoot, 'roveagent', 'api', 'stream_wire.py'),
    'utf8',
  );
  // `"type":` 在 stream_wire.py 中只用于事件类型（无其它同名键）
  const found = new Set<string>();
  const pattern = /"type":\s*"([a-z_]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    found.add(match[1]);
  }
  return found;
}

test('Python 产出的每个事件名都在前端白名单内', () => {
  const produced = pythonEventTypes();
  assert.ok(produced.size >= 6, `只解析到 ${produced.size} 个事件名，解析可能失败`);
  for (const type of produced) {
    assert.ok(
      KNOWN_EVENT_TYPES.has(type),
      `Python 产出 "${type}" 但 use-sse.ts 白名单没有它 —— 会被静默丢弃`,
    );
  }
});

test('白名单覆盖 Step 2 必需的事件类型', () => {
  // runtime_status 与 approval 是 Step 2 明确要求补齐的（原先缺失导致丢弃）
  for (const required of ['runtime_status', 'approval', 'delta', 'status', 'notice', 'done', 'error']) {
    assert.ok(KNOWN_EVENT_TYPES.has(required), `白名单缺少 "${required}"`);
  }
});

test('不得为后端事件自造名字（token/tool_call/tool_result/completed）', () => {
  // 这些是需求文档里的说法，但前端契约用的是 delta/status/done
  const produced = pythonEventTypes();
  for (const forbidden of ['token', 'tool_call', 'tool_result', 'completed']) {
    assert.ok(
      !produced.has(forbidden),
      `Python 侧出现了自造事件名 "${forbidden}"；必须映射到既有契约`,
    );
  }
});

test('AgentSseEvent 联合类型包含 runtime_status', () => {
  const source = readFileSync(
    path.join(repoRoot, 'src', 'lib', 'agent', 'stream-events.ts'),
    'utf8',
  );
  assert.match(source, /AgentRuntimeStatusEvent/, '缺少 AgentRuntimeStatusEvent 定义');
  assert.match(
    source,
    /\|\s*AgentRuntimeStatusEvent/,
    'AgentSseEvent 联合类型未并入 AgentRuntimeStatusEvent',
  );
});

test('runtime_status 的 mode 取值与 Python 侧一致', () => {
  const py = readFileSync(
    path.join(repoRoot, 'roveagent', 'api', 'stream_wire.py'),
    'utf8',
  );
  // Python 文档串里声明了三个 mode
  for (const mode of ['roveagent', 'fallback', 'unavailable']) {
    assert.ok(py.includes(mode), `stream_wire.py 未提及 mode "${mode}"`);
  }
});
