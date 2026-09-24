import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PERSONAS, resolvePersonaKey } from '../src/lib/agent/personas';

/**
 * 记录一次正当变更（2026-09-25）：persona 由 4 个变为 5 个。
 *
 * 原断言写死 `PERSONAS.length === 4`，而运行时 `capability_router.py` 里
 * `developer`（file/terminal/git/skills 工具集）一直存在，前端却没有任何 persona
 * 映射到它 —— 用户实测「这个不能编码啊」时拿到的是 CEO Agent 的
 * "I don't have access to a terminal or file system"（CEO 本就不碰文件与终端）。
 *
 * 因此新增 Developer persona。下面不再写死数字，而是锁定**精确的 key 集合与映射**
 * ——这样"少一个"和"多一个"都会红，且不依赖魔法数字。
 */
test('executive personas exist with stable employee mapping', () => {
  const byKey = new Map(PERSONAS.map((p) => [p.key, p]));
  assert.deepEqual(
    [...byKey.keys()].sort(),
    ['ceo-insight', 'cmo', 'coo', 'cto', 'developer'],
    'persona 集合发生变化时必须显式更新本断言（缺失或多出都要可见）',
  );
  assert.equal(PERSONAS.length, byKey.size, 'persona key 不得重复');
  assert.equal(byKey.get('ceo-insight')?.employeeKey, 'ceo');
  assert.equal(byKey.get('coo')?.employeeKey, 'operations');
  assert.equal(byKey.get('cmo')?.employeeKey, 'marketing');
  assert.equal(byKey.get('cto')?.employeeKey, 'devops');
  assert.equal(byKey.get('developer')?.employeeKey, 'developer');
});

test('resolvePersonaKey normalizes unknown values to ceo-insight', () => {
  assert.equal(resolvePersonaKey('cmo'), 'cmo');
  assert.equal(resolvePersonaKey('cto'), 'cto');
  assert.equal(resolvePersonaKey(undefined), 'ceo-insight');
  assert.equal(resolvePersonaKey('hacker'), 'ceo-insight');
});

test('chat route forwards persona as employee key and never trusts raw input', () => {
  const source = readFileSync(join(process.cwd(), 'src/app/api/agent/chat/route.ts'), 'utf8');
  assert.match(source, /resolvePersonaKey/);
  assert.match(source, /PERSONA_EMPLOYEE/);
});

test('agent page exposes persona selector chips', () => {
  const source = readFileSync(join(process.cwd(), 'src/app/[locale]/agent/page.tsx'), 'utf8');
  assert.match(source, /PERSONAS\.map/);
  assert.match(source, /setPersona/);
  assert.match(source, /persona,/);
});

test('python personas map to the single runtime workforce', () => {
  const source = readFileSync(join(process.cwd(), 'roveagent/workforce/personas.py'), 'utf8');
  for (const key of ['ceo-insight', 'coo', 'cmo', 'cto', 'developer']) {
    assert.ok(source.includes('"' + key + '"'), key + ' persona missing');
  }
});
