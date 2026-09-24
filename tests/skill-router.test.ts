import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { matchSkills, skillHintsPrompt, type SkillHintSource } from '../src/lib/agent/skill-router';

/**
 * 任务 → 技能路由：把"这一轮该用哪个技能"从"指望模型想起来"变成确定性匹配。
 *
 * ## 为什么
 *
 * 运行时只把技能索引（名字+描述）放进系统提示词，正文要模型自己 `skill_view` 取；
 * 仓库自己的注释就记着这个弱点（`core/coding_context.py`：
 * models do not reliably reach for `skills_list`…）。实测印证：问 CEO「你有哪些技能」
 * 它能列全，但做具体任务时不会主动加载。于是"装了 18 个技能"与"agent 真的会用"
 * 之间差这一步。
 *
 * 本测试锁住三件必须成立的事：
 *   1. 相关的能匹配上（中英文都要）
 *   2. **没装给租户的技能不能被提示** —— 提示它等于让模型去调一个调不动的技能
 *   3. 不相关的不许硬凑（塞一堆无关技能就是给模型加噪音）
 */

/** 与线上一致的真实技能样本。 */
const SKILLS: SkillHintSource[] = [
  { name: 'menu-optimization', description: '菜单毛利优化：用销量×毛利把菜品分到四个象限，给出改价、改配方、调结构、下架的具体建议。', installed: true },
  { name: 'inventory-forecast', description: '库存预测与补货建议：按近 N 天消耗速率推算可用天数，区分"该补"与"该等"。', installed: true },
  { name: 'win-back-campaign', description: '流失客户召回：按沉默天数分层，逐人个性化写文案，限流外发。', installed: true },
  { name: 'review-response', description: '差评回复：24 小时内按问题类型给出可直接用的回复草稿。', installed: true },
  { name: 'docx', description: 'Create, read, edit, template, and review Word .docx files.', installed: true },
  // 未装给本租户：即使名字被点名也不该提示
  { name: 'appointment-optimizer', description: 'Healthcare Pack 内置技能', installed: false },
];

describe('匹配：相关的要能命中', () => {
  test('中文任务命中中文描述的技能', () => {
    const names = matchSkills('帮我看看菜单毛利，哪些菜该涨价', SKILLS).map((m) => m.name);
    assert.ok(names.includes('menu-optimization'), `应命中 menu-optimization，实际: ${names.join(',')}`);
  });

  test('另一个中文任务命中对应技能（不能只认一个）', () => {
    const names = matchSkills('库存还够用几天？哪些该补货了', SKILLS).map((m) => m.name);
    assert.ok(names.includes('inventory-forecast'), `应命中 inventory-forecast，实际: ${names.join(',')}`);
  });

  test('英文任务命中英文描述的技能', () => {
    const names = matchSkills('please review this word document and export docx', SKILLS).map((m) => m.name);
    assert.ok(names.includes('docx'), `应命中 docx，实际: ${names.join(',')}`);
  });

  test('直接点名技能时分数最高且排第一', () => {
    const matches = matchSkills('用 menu-optimization 分析一下', SKILLS);
    assert.equal(matches[0]?.name, 'menu-optimization');
    assert.ok(matches[0].score >= 10, '点名应拿到至少 10 分');
  });

  test('结果带 matched 词，便于解释为什么匹配到它', () => {
    const matches = matchSkills('菜单毛利怎么优化', SKILLS);
    const menu = matches.find((m) => m.name === 'menu-optimization');
    assert.ok(menu && menu.matched.length > 0, 'matched 必须非空，否则无法排查误配');
  });
});

describe('不变量：只提示已装技能', () => {
  test('installed=false 的技能即使被点名也不出现', () => {
    const names = matchSkills('用 appointment-optimizer 排一下', SKILLS).map((m) => m.name);
    assert.equal(
      names.includes('appointment-optimizer'),
      false,
      '未装给该租户的技能不能提示 —— 模型会去调一个它根本调不动的技能',
    );
  });

  test('负向对照：如果不过滤 installed，它确实会被选中（说明这条断言不是空转的）', () => {
    const withoutFilter = SKILLS.map((s) => ({ ...s, installed: true }));
    const names = matchSkills('用 appointment-optimizer 排一下', withoutFilter).map((m) => m.name);
    assert.ok(
      names.includes('appointment-optimizer'),
      '把 installed 全设为 true 后它应当被选中 —— 否则上面的过滤断言测不出东西',
    );
  });
});

describe('噪音控制：不相关的不许硬凑', () => {
  test('完全无关的问题不返回任何技能', () => {
    assert.deepEqual(matchSkills('今天天气怎么样', SKILLS), []);
    assert.deepEqual(matchSkills('hello there', SKILLS), []);
  });

  test('空消息不返回任何技能', () => {
    assert.deepEqual(matchSkills('', SKILLS), []);
    assert.deepEqual(matchSkills('   ', SKILLS), []);
  });

  test('topN 限制条数', () => {
    const many: SkillHintSource[] = Array.from({ length: 10 }, (_, i) => ({
      name: `menu-helper-${i}`,
      description: '菜单 毛利 优化 建议 分析',
      installed: true,
    }));
    assert.equal(matchSkills('菜单毛利优化建议', many, { topN: 3 }).length, 3);
    assert.equal(matchSkills('菜单毛利优化建议', many, { topN: 1 }).length, 1);
  });

  test('负向对照：单个二字组不足以触发 —— 证明阈值真的在起作用', () => {
    // 「建议」是 menu-optimization 描述里真实存在的二字组，但只有这一个。
    // 默认阈值下不该命中（否则任何带"建议"的闲聊都会拖出技能清单）；
    // 阈值降到 1 时必须命中 —— 两者不同才说明是阈值在过滤，而不是打分函数没反应。
    const singleBigram = '有什么建议吗';
    assert.deepEqual(matchSkills(singleBigram, SKILLS), [], '默认阈值下单个二字组不该命中');
    const loose = matchSkills(singleBigram, SKILLS, { minScore: 1, topN: 10 });
    assert.ok(
      loose.length > 0,
      '阈值降到 1 时应当命中（说明打分函数对该二字组有反应，' +
        '上面的"空结果"确实是阈值起的作用，而非打分失效）',
    );
  });
});

describe('确定性', () => {
  test('同一输入两次调用结果完全一致（分数相同时按名字排序）', () => {
    const a = matchSkills('菜单 库存 差评 召回 都看看', SKILLS, { topN: 4 });
    const b = matchSkills('菜单 库存 差评 召回 都看看', SKILLS, { topN: 4 });
    assert.deepEqual(a, b);
  });
});

describe('提示词渲染', () => {
  test('没有命中时返回空串（不往上下文里塞空标题）', () => {
    assert.equal(skillHintsPrompt([], 'zh'), '');
    assert.equal(skillHintsPrompt([], 'en'), '');
  });

  test('有命中时列出技能名与用途，并要求先读取再动手', () => {
    const matches = matchSkills('帮我优化菜单毛利', SKILLS);
    const prompt = skillHintsPrompt(matches, 'zh');
    assert.match(prompt, /menu-optimization/, '必须列出技能名，否则模型不知道去 skill_view 什么');
    assert.match(prompt, /skill_view/, '必须要求先加载完整步骤 —— 只报名不解决"模型不去读"的问题');
  });

  test('英文语种用英文措辞', () => {
    const matches = matchSkills('review this docx', SKILLS);
    const prompt = skillHintsPrompt(matches, 'en');
    assert.match(prompt, /skill_view/);
    assert.match(prompt, /skills installed|Skill/i);
  });
});
