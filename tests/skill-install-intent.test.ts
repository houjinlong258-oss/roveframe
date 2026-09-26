import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasInstallIntent,
  installIntentHint,
  skillHintsPrompt,
} from '../src/lib/agent/skill-router';

/**
 * 安装意图的**收窄**判定。
 *
 * ## 为什么这段判定比它看起来重要
 *
 * `skill_manage(action="fetch")` 会去克隆**任意 git 主机**上的仓库（这是已批准的
 * 取回范围）。如果把"你可以联网装技能"写进每一轮上下文，就等于持续诱导模型自己
 * 去找东西装 —— 与产品「先批准再动手」的调性相反，而且是把主动权塞给了一个不该
 * 有的角色。
 *
 * 所以这段提示必须**只在意图明确时**出现，而"意图明确"的反面（提到"技能"但不是在
 * 找技能）正是最容易写错的地方 —— 下面两组的后一组就是钉这个的。
 */

describe('安装意图：必须触发', () => {
  const SHOULD_FIRE = [
    '帮我装一个技能',
    '安装技能',
    '有没有能写小红书的技能',
    '找找有没有做库存预测的技能',
    '推荐一些技能',
    '技能市场里有什么',
    'install a skill for invoices',
    'can you add a skill that writes invoices',
    'find me a skill for menu optimization',
    'search for skills about churn',
    'skill marketplace',
    'instalar una habilidad',
  ];

  for (const message of SHOULD_FIRE) {
    test(`触发：${message}`, () => {
      assert.equal(hasInstallIntent(message), true, `未识别为安装意图：${message}`);
      assert.notEqual(installIntentHint(message, 'zh'), '');
    });
  }
});

describe('安装意图：必须不触发（防误报）', () => {
  // 这组是上面那组的负向对照。任何一条误报，都会让某个高频问句变成
  // "把 fetch 的用法塞进上下文"。
  const SHOULD_NOT_FIRE = [
    '你有哪些技能',
    '用你的技能分析订单',
    '看看这个月的营收',
    '技能',
    '',
    '   ',
    'what skills do you have',
    'use your skills to analyze orders',
    'monthly revenue',
  ];

  for (const message of SHOULD_NOT_FIRE) {
    test(`不触发：${JSON.stringify(message)}`, () => {
      assert.equal(hasInstallIntent(message), false, `误判为安装意图：${message}`);
      assert.equal(installIntentHint(message, 'zh'), '');
    });
  }
});

describe('提示内容与组合', () => {
  test('中英两版都点明两步动作与高影响会挂起（不鼓励自己去搜）', () => {
    for (const locale of ['zh', 'en']) {
      const hint = installIntentHint('装一个技能', locale);
      assert.match(hint, /fetch/);
      assert.match(hint, /install/);
      // 必须说清高影响会等人批，否则 Agent 会以为装不上而反复重试。
      assert.match(locale === 'zh' ? hint : hint, /approval|批准/);
    }
  });

  test('相邻安全属性：原来的技能提示在无命中时仍返回空串', () => {
    // 组合逻辑依赖 filter(Boolean)：空串必须真的被滤掉。
    assert.equal(skillHintsPrompt([], 'zh'), '');
    assert.equal(installIntentHint('看看营收', 'zh'), '');
    const combined = [skillHintsPrompt([], 'zh'), installIntentHint('看看营收', 'zh')]
      .filter(Boolean)
      .join('\n\n');
    assert.equal(combined, '', '无命中时不应产出任何上下文');
  });

  test('确定性：同样的输入给同样的结果', () => {
    const a = installIntentHint('帮我装一个技能', 'zh');
    const b = installIntentHint('帮我装一个技能', 'zh');
    assert.equal(a, b);
  });
});
