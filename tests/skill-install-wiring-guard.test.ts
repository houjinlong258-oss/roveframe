import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 接线 `install` 之前的危险护栏（先读代码、再改代码的绊线）。
 *
 * 背景：`Skill_Fetch_Design.md` 决定「低影响自动装、高影响需人批」。动手接线时
 * 最省事的做法是**把 `install` 加进现有的技能写入门** —— 那恰好是错的，因为
 * `write_approval.evaluate_gate` 的决策矩阵是**按子系统一刀切**：
 *
 *     gate on, skills (any origin) → stage
 *
 * 于是设置一关，`shell:execute` 就跟着自动安装；设置一开，只读技能也被拦住。
 * 两种都不等于已批准的设计。
 *
 * 这不是"以后可能有问题"，是接线时几乎必然会被走错的一步，所以在这里钉住：
 * 谁把它加进那个集合，测试立刻变红并说明原因。
 *
 * 第二条钉住的是**回放通道的信息缺口**：`apply_skill_pending` 逐项枚举它转发的
 * 参数，其中没有 source（隔离目录），也没有任何"本次批准授予了哪些能力"的字段。
 * 所以 install 一旦被挂起，是无法被正确回放的 —— 而 grants 必须来自人的批准，
 * 不能从 payload 里自取。接线时这两处必须一起改，这条测试就是提醒。
 */

const SRC = readFileSync(
  join(process.cwd(), 'roveagent', 'tools', 'skill_manager_tool.py'),
  'utf8',
);

const GATED_ACTIONS = new Set([
  'create',
  'edit',
  'patch',
  'delete',
  'write_file',
  'remove_file',
]);

describe('install 接线前的危险护栏', () => {
  test('install 没有被加进 _apply_skill_write_gate 的 action 集合', () => {
    const gate = SRC.match(/_apply_skill_write_gate\([\s\S]*?\n\}\n/);
    assert.ok(gate, '找不到 _apply_skill_write_gate —— 前提失效，请重新阅读该函数');
    const setMatch = gate[0].match(/if action not in \{([^}]*)\}/);
    assert.ok(setMatch, '找不到 action 集合字面量 —— 解析失败，断言可能空转');
    const actions = setMatch[1]
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
    assert.deepEqual(
      [...actions].sort(),
      [...GATED_ACTIONS].sort(),
      '技能写入门的 action 集合变了。若把 install 加了进去：那会按子系统设置一刀切，' +
        '关掉设置即等于自动安装 shell 级技能，与已批准的能力阈值设计相反。' +
        'install 必须走 install_policy.decide_install_policy。',
    );
    // 自我校验：这个集合确实被解析出来了，否则上面的 deepEqual 可能只是两个空数组相等。
    assert.ok(actions.length >= 6, `只解析出 ${actions.length} 个 action，解析可能失效`);
  });

  test('授权只能来自批准记录，且 Agent 无法在签名里自授', () => {
    // 这条钉的是「谁授予了哪些能力」。它曾经断言"回放不携带 source"（当时的
    // 事实是回放无法承载 install）；接线完成后改为断言新的正向不变量。
    const replay = SRC.match(/def apply_skill_pending\([\s\S]*?\n    finally:\n/);
    assert.ok(replay, '找不到 apply_skill_pending —— 前提失效');
    assert.match(
      replay[0],
      /_apply_pending_install\(payload\)/,
      'apply_skill_pending 未把 install 交给专门的回放函数',
    );

    const pending = SRC.match(/def _apply_pending_install\([\s\S]*?\n    try:\n/);
    assert.ok(pending, '找不到 _apply_pending_install —— 授权来源无从审计');
    assert.match(
      pending[0],
      /payload\.get\("granted"\)/,
      '回放的授权不是从批准记录读的 —— 那就等于让写入方自授权',
    );
    assert.match(
      pending[0],
      /no recorded grants/,
      '记录里没有授权时没有 fail-closed 分支 —— 会变成"无授权即放行"',
    );

    // Agent 可见的签名里不得出现 granted：schema 由签名派生，出现即等于可自授。
    const signature = SRC.match(/def skill_manage\(([\s\S]*?)\) -> str:/);
    assert.ok(signature, '找不到 skill_manage 签名');
    const params = signature[1];
    assert.ok(params.includes('source'), '签名里没有 source —— fetch/install 无法被调用');
    assert.ok(
      !/\bgranted\b/.test(params),
      'skill_manage 签名里出现了 granted —— schema 由签名派生，' +
        '这等于让 Agent 自己指定能力，是自授权漏洞',
    );
  });

  test('技能门仍由 write_approval 的 SKILLS 子系统决策（阈值层不被它吸收）', () => {
    assert.match(
      SRC,
      /wa\.evaluate_gate\(wa\.SKILLS\)/,
      '技能写入门不再调用 evaluate_gate(wa.SKILLS) —— 审批通道被改动了，需重新阅读',
    );
  });
});
