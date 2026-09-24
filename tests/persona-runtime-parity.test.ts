import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PERSONAS, type PersonaKey } from '../src/lib/agent/personas';

/**
 * 界面 persona 与运行时能力画像的一致性 —— 一个「能力黑洞」的守卫。
 *
 * ## 缺陷现场
 *
 * 用户反馈：「还有这个不能编码啊，这几个 ai agent 全是假的干不了活啊」。
 *
 * 实测：用默认的 CEO Agent 让它「写个 Python 脚本并跑一下」，它的回答是
 *
 *     I don't have access to a terminal or file system to create and run the script.
 *
 * 它**没说错**。运行时 `roveagent/api/capability_router.py` 的能力画像里，
 * `ceo` 的 summary 原文就是「不碰文件与终端」。
 *
 * 真正的问题在于：运行时**有一个工具集最全的编码 agent**
 *
 *     "developer": toolsets=("file","terminal","todo","git","skills","delegation")
 *
 * 而前端 `PERSONAS` 只有 4 个（ceo / operations / marketing / devops），
 * **没有任何一个映射到 `developer`** —— 这个编码 agent 从界面上永远够不到。
 * 用户不是"用错了角色"，是**根本没有可选的编码角色**。
 *
 * ## 本测试守住什么
 *
 * 1. 每个前端 persona 的 `employeeKey` 必须存在于运行时的 AGENT_CAPABILITIES。
 *    这是一条**跨语言**一致性（TS ↔ Python），tsc 抓不到，只有测试能抓。
 * 2. 「能读写代码」的能力必须**从界面可达**：至少有一个 persona 映射到的 agent
 *    同时具备 `file` 与 `terminal` 工具集。这条断言正是当初会变红的那个。
 *
 * 注意：`PERSONA_SIGNALS: Record<PersonaKey, ...>` 的完整性由 tsc 保证
 * （漏一个 key 就编译不过），因此不在本文件重复。
 */

const ROOT = process.cwd();
const CAPABILITY_ROUTER = join('roveagent', 'api', 'capability_router.py');
const pythonSource = readFileSync(join(ROOT, CAPABILITY_ROUTER), 'utf8');

interface RuntimeAgent {
  key: string;
  toolsets: string[];
}

/** 从 Python 能力画像表里解析出 agent → toolsets。 */
function parseRuntimeAgents(src: string): RuntimeAgent[] {
  const re = /"([a-z_]+)":\s*AgentCapability\(([\s\S]*?)toolsets=\(([^)]*)\)/g;
  const out: RuntimeAgent[] = [];
  for (const m of src.matchAll(re)) {
    out.push({
      key: m[1],
      toolsets: m[3]
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean),
    });
  }
  return out;
}

const runtimeAgents = parseRuntimeAgents(pythonSource);
const runtimeByKey = new Map(runtimeAgents.map((a) => [a.key, a]));

/**
 * 从一组 persona 里挑出「能读写代码」的 agent。
 * 由下面的负向对照证明它**能返回空集**（否则这条断言是空转的）。
 */
function codingPersonas(personas: ReadonlyArray<{ key: string; employeeKey: string }>): string[] {
  return personas
    .filter((p) => {
      const agent = runtimeByKey.get(p.employeeKey);
      if (!agent) return false;
      return agent.toolsets.includes('file') && agent.toolsets.includes('terminal');
    })
    .map((p) => p.key);
}

describe('能力画像解析本身是可信的', () => {
  test('能从运行时解析出能力画像表', () => {
    assert.ok(
      runtimeAgents.length >= 4,
      `应从 ${CAPABILITY_ROUTER} 解析出至少 4 个 agent，实际 ${runtimeAgents.length} 个`,
    );
  });

  test('解析出的画像包含编码 agent 且其工具集含 file 与 terminal', () => {
    const dev = runtimeByKey.get('developer');
    assert.ok(dev, '运行时必须存在 developer 能力画像，否则本守卫的前提已变');
    assert.ok(dev.toolsets.includes('file'), `developer 应具备 file 工具集，实际: ${dev.toolsets.join(',')}`);
    assert.ok(dev.toolsets.includes('terminal'), `developer 应具备 terminal 工具集，实际: ${dev.toolsets.join(',')}`);
  });

  test('CEO 画像确实不含文件与终端（解释「它说不能编码」不是 bug）', () => {
    const ceo = runtimeByKey.get('ceo');
    assert.ok(ceo, '运行时必须存在 ceo 能力画像');
    assert.equal(ceo.toolsets.includes('file'), false, 'CEO 本就不该有文件工具');
    assert.equal(ceo.toolsets.includes('terminal'), false, 'CEO 本就不该有终端工具');
  });
});

describe('界面 persona 与运行时能力画像一致', () => {
  test('每个 persona 的 employeeKey 都是运行时已知的 agent', () => {
    for (const persona of PERSONAS) {
      assert.ok(
        runtimeByKey.has(persona.employeeKey),
        `persona「${persona.key}」映射到 employeeKey="${persona.employeeKey}"，` +
          `但运行时 AGENT_CAPABILITIES 里没有这个 agent —— 界面选得中、运行时给不出工具集。` +
          `已知: ${[...runtimeByKey.keys()].join(', ')}`,
      );
    }
  });

  test('persona key 与 employeeKey 都不得重复（否则选择器会指向同一个能力）', () => {
    const keys = PERSONAS.map((p) => p.key);
    const employees = PERSONAS.map((p) => p.employeeKey);
    assert.equal(new Set(keys).size, keys.length, `persona key 重复: ${keys.join(', ')}`);
    assert.equal(new Set(employees).size, employees.length, `employeeKey 重复: ${employees.join(', ')}`);
  });

  test('「能读写代码」的能力必须从界面可达', () => {
    const reachable = codingPersonas(PERSONAS);
    assert.ok(
      reachable.length >= 1,
      '没有任何 persona 映射到同时具备 file + terminal 的 agent —— ' +
        '这就是「用户根本无法让 agent 写代码」的能力黑洞。' +
        `当前 persona: ${PERSONAS.map((p) => `${p.key}->${p.employeeKey}`).join(', ')}`,
    );
    assert.deepEqual(reachable, ['developer'], '编码能力应当且仅由 Developer 这个 persona 承载');
  });

  test('负向对照：把 Developer 拿掉后，上面那条断言必须失败（复现原始缺陷）', () => {
    const withoutDeveloper = PERSONAS.filter((p) => p.key !== 'developer');
    assert.equal(
      withoutDeveloper.length,
      PERSONAS.length - 1,
      '负向对照的前提：Developer persona 确实存在于列表中',
    );
    assert.deepEqual(
      codingPersonas(withoutDeveloper),
      [],
      '原始 4 个 persona（ceo/operations/marketing/devops）里**没有**任何一个具备 file+terminal —— ' +
        '这正是当初那个能力黑洞。检测器能返回空集，说明上面那条断言不是空转的。',
    );
  });

  test('负向对照：检测器不认识虚构的 employeeKey', () => {
    const bogus = [{ key: 'ghost' as PersonaKey, employeeKey: 'not_a_real_agent' }];
    assert.deepEqual(codingPersonas(bogus), [], '未知 agent 必须被判为不可达编码能力');
  });
});
