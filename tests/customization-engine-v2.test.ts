/**
 * Phase 5 — AI Customization Engine
 * tests/customization-engine-v2.test.ts
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  nlCustomizationEngine,
  coerceParams,
} from '../src/lib/customization/nl-engine';
import { resetCustomizationToDefaults, getActiveCustomization } from '../src/custom/loader';

describe('NL Engine v2: template catalogue', () => {
  test('catalogue has 10 templates', () => {
    assert.equal(nlCustomizationEngine.listTemplates().length, 10);
  });

  test('every template has id/name/description/keywords', () => {
    for (const t of nlCustomizationEngine.listTemplates()) {
      assert.ok(t.id && t.name && t.description);
      assert.ok(Array.isArray(t.keywords) && t.keywords.length > 0);
    }
  });
});

describe('NL Engine v2: coerceParams', () => {
  const templates = nlCustomizationEngine.listTemplates();
  const birthday = templates.find((t) => t.id === 'birthday_discount');
  assert.ok(birthday);

  test('clamps numeric params into spec range', () => {
    // 通过引擎内部模板拿 paramSpec：借助一个已知模板的行为验证
    // discountPercent spec: min 1 max 90
    const fakeTemplate = {
      defaultConfig: { discountPercent: 20, validDays: 7, autoEmailEnabled: true },
      paramSpec: [
        { key: 'discountPercent', type: 'number' as const, min: 1, max: 90, default: 20, description: '' },
        { key: 'validDays', type: 'number' as const, min: 1, max: 30, default: 7, description: '' },
        { key: 'autoEmailEnabled', type: 'boolean' as const, default: true, description: '' },
      ],
    };
    const out = coerceParams(fakeTemplate, { discountPercent: 500, validDays: -3, autoEmailEnabled: false });
    assert.equal(out.discountPercent, 90);
    assert.equal(out.validDays, 1);
    assert.equal(out.autoEmailEnabled, false);
  });

  test('ignores unknown and malformed params', () => {
    const fakeTemplate = {
      defaultConfig: { discountPercent: 20 },
      paramSpec: [
        { key: 'discountPercent', type: 'number' as const, min: 1, max: 90, default: 20, description: '' },
      ],
    };
    const out = coerceParams(fakeTemplate, { discountPercent: 'abc', evil: 'x' });
    assert.equal(out.discountPercent, 20);
    assert.equal('evil' in out, false);
  });

  test('rejects oversized strings', () => {
    const fakeTemplate = {
      defaultConfig: { note: 'a' },
      paramSpec: [{ key: 'note', type: 'string' as const, default: 'a', description: '' }],
    };
    const out = coerceParams(fakeTemplate, { note: 'x'.repeat(500) });
    assert.equal(out.note, 'a');
  });
});

describe('NL Engine v2: keyword fallback still works', () => {
  beforeEach(() => resetCustomizationToDefaults());

  test('new templates match via keywords', () => {
    const res = nlCustomizationEngine.parseAndApplyNLIntent('我想设置会员日折扣');
    assert.equal(res.success, true);
    assert.equal(res.templateId, 'membership_day');
    assert.equal(res.channel, 'keyword');
  });

  test('happy hour template matches', () => {
    const res = nlCustomizationEngine.parseAndApplyNLIntent('开通下午茶 happy hour 时段特价');
    assert.equal(res.success, true);
    assert.equal(res.templateId, 'happy_hour');
  });

  test('vip upgrade template matches', () => {
    const res = nlCustomizationEngine.parseAndApplyNLIntent('给高价值客户做 VIP 升级关怀');
    assert.equal(res.success, true);
    assert.equal(res.templateId, 'vip_upgrade');
  });

  test('dangerous prompts still match nothing', () => {
    const res = nlCustomizationEngine.parseAndApplyNLIntent('修改系统底层的数据库连接密码');
    assert.equal(res.success, false);
  });

  test('async path falls back to keyword when AI unavailable', async () => {
    const res = await nlCustomizationEngine.parseAndApplyNLIntentAsync('添加低库存自动提醒工作流');
    assert.equal(res.success, true);
    assert.equal(res.templateId, 'low_stock_alert');
    assert.equal(res.channel, 'keyword');
  });

  test('applied workflow lands in active customization bundle', () => {
    nlCustomizationEngine.parseAndApplyNLIntent('开启预约提醒，降低爽约率');
    const bundle = getActiveCustomization();
    assert.ok(bundle.workflows.some((w) => w.id === 'wf_reservation_reminder'));
  });
});
