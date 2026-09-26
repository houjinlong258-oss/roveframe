import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `Skill_Fetch_Design.md` 引用了一批 `file:line` 前提。文档会腐烂 —— 机制被改名、
 * 被移走、或被悄悄放宽之后，设计文档仍然读起来是对的。
 *
 * 所以这里把**前提本身**变成可失败的断言：任何一条被破坏，这些测试变红，
 * 提醒改设计的人「你依赖的东西不在了」，而不是让人在实现到一半时才发现。
 *
 * 内建负向对照：每个解析型断言都先检查「确实解析出了东西」，避免正则失效后
 * 检查了个寂寞还显示通过。
 */

function read(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

const PERMISSIONS = read('roveagent', 'skills_market', 'permissions.py');
const SCANNER = read('roveagent', 'skills_market', 'scanner.py');
const INSTALLER = read('roveagent', 'skills_market', 'installer.py');
const PLUGINS_CMD = read('roveagent', 'clisupport', 'plugins_cmd.py');

describe('技能联网获取设计的前提', () => {
  test('Capability 恰好 7 个成员（阈值表就是按它写的）', () => {
    // 不能用 /class Capability…([\s\S]*?)\n\n/ 截类体：类体开头是 docstring，
    // 第一个空行紧跟在 docstring 之后，会截出 **0 个成员** —— 本测试初版正是
    // 这么写的，于是基线就红（自己的测试把正确代码判成错）。
    // 改成「类声明 → ALL_CAPABILITIES 常量」之间切片，不依赖空行布局。
    const from = PERMISSIONS.indexOf('class Capability');
    // 必须从 from 之后开始找：`__all__` 里也有字符串 "ALL_CAPABILITIES"，
    // 它出现在 class 声明**之前**，直接 indexOf 会取到那里（本测试第二版就是
    // 这么错的，边界断言炸在基线上）。要求行首匹配，进一步排除注释/文档提及。
    const to = PERMISSIONS.indexOf('\nALL_CAPABILITIES', from);
    assert.ok(from >= 0 && to > from, '找不到 Capability 类的边界 —— 前提已失效');
    const members = [...PERMISSIONS.slice(from, to).matchAll(/^\s{4}([A-Z_]+) = "([^"]+)"/gm)];
    assert.ok(members.length > 0, '解析到 0 个成员，正则可能失效');
    assert.equal(
      members.length,
      7,
      `Capability 现在是 ${members.length} 个成员（设计文档按 7 个写的）：` +
        members.map((m) => m[1]).join(', '),
    );
  });

  test('HIGH_IMPACT 仍是 5 个，且不含 FILES_READ / SKILL_INVOKE', () => {
    const block = PERMISSIONS.match(/HIGH_IMPACT[^=]*=\s*frozenset\(\{([\s\S]*?)\}\)/);
    assert.ok(block, '找不到 HIGH_IMPACT 定义 —— 审批阈值的前提没了');
    const names = [...block[1].matchAll(/Capability\.([A-Z_]+)/g)].map((m) => m[1]);
    assert.ok(names.length > 0, '解析到 0 个成员，正则可能失效');
    assert.deepEqual(
      [...names].sort(),
      ['ENV_SECRETS', 'FILES_WRITE', 'NETWORK_EGRESS', 'PROCESS_CONTROL', 'SHELL_EXECUTE'],
      'HIGH_IMPACT 成员变了 —— 审批阈值（自动 vs 需人批）会随之改变，设计文档必须同步',
    );
    for (const low of ['FILES_READ', 'SKILL_INVOKE']) {
      assert.ok(
        !names.includes(low),
        `${low} 被加进 HIGH_IMPACT：那会让「只读技能也要人批」，与设计文档不符`,
      );
    }
  });

  test('能力可从内容推断（"声明 ∪ 推断"这条 fail-closed 细则依赖它）', () => {
    assert.match(
      PERMISSIONS,
      /def capabilities_from_content\(/,
      'capabilities_from_content 不存在了 —— 技能可只靠少声明绕过阈值',
    );
    assert.match(PERMISSIONS, /"capabilities_from_content"/, '未导出，外部无法调用');
  });

  test('扫描器的 BLOCKING 仍同时包含 HIGH 与 CRITICAL（一律拒绝的那道门）', () => {
    const block = SCANNER.match(/BLOCKING[^=]*=\s*frozenset\(\{([^}]*)\}\)/);
    assert.ok(block, '找不到 BLOCKING 定义');
    assert.match(block[1], /Severity\.HIGH/, 'BLOCKING 不再包含 HIGH');
    assert.match(block[1], /Severity\.CRITICAL/, 'BLOCKING 不再包含 CRITICAL');
  });

  test('扫描器确实有 prompt-injection 模式（文档纠正过的那条结论）', () => {
    // 负向对照：这条断言在本仓库必须为真。若有人删掉这些模式，
    // 设计文档 §5/§6 关于"扫描器已覆盖注入形态"的说法就不再成立。
    const critical = [...SCANNER.matchAll(/Severity\.CRITICAL,\s*"([^"]+)"/g)].map((m) => m[1]);
    const high = [...SCANNER.matchAll(/Severity\.HIGH,\s*"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(critical.length + high.length >= 3, `注入类模式过少：${critical.length + high.length}`);
    const all = [...critical, ...high].join(' ');
    assert.match(all, /instruction-override|extract the system prompt|role-reassignment/,
      '找不到注入类模式描述 —— 文档 §6 的结论需要重新核实');
  });

  test('installer.py 仍是无网络的（新的取回能力不得渗进这里）', () => {
    for (const banned of [
      'import subprocess',
      'import socket',
      'import urllib',
      'import requests',
      'import httpx',
      'import shutil as git',
    ]) {
      assert.ok(
        !INSTALLER.includes(banned),
        `installer.py 出现了 \`${banned}\` —— 网络/进程能力渗进了刻意保持无网络的模块`,
      );
    }
    assert.match(
      INSTALLER,
      /No network/,
      'installer.py 的 "No network" 不变量说明被删了 —— 先确认它是否仍然成立',
    );
  });

  test('复用目标 _resolve_git_url 仍在（取回阶段不重写 URL 解析）', () => {
    assert.match(
      PLUGINS_CMD,
      /def _resolve_git_url\(/,
      '_resolve_git_url 不存在了 —— 取回阶段需要自己实现 URL 解析，设计需更新',
    );
  });

  test('设计文档存在，且引用的核心符号能被找到', () => {
    const doc = join(process.cwd(), 'Skill_Fetch_Design.md');
    assert.ok(existsSync(doc), 'Skill_Fetch_Design.md 不存在');
    const text = readFileSync(doc, 'utf8');
    for (const symbol of ['HIGH_IMPACT', 'capabilities_from_content', '_resolve_git_url', 'skill-quarantine']) {
      assert.ok(text.includes(symbol), `设计文档未提及 ${symbol}`);
    }
  });
});
