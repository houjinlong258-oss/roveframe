import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nlCustomizationEngine } from '../src/lib/customization/nl-engine';
import { resetCustomizationToDefaults, getActiveCustomization } from '../src/custom/loader';

test('NL Customization: matches "增加一个生日会员优惠功能" to birthday_discount template', () => {
  resetCustomizationToDefaults();
  const res = nlCustomizationEngine.parseAndApplyNLIntent('增加一个生日会员优惠功能');
  assert.equal(res.success, true);
  assert.equal(res.templateId, 'birthday_discount');
  assert.ok(res.generatedConfig);
  assert.equal(res.generatedConfig.discountPercent, 20);

  const active = getActiveCustomization();
  assert.equal(active.rules.customRuleFlags.enableBirthdayDiscount, true);
  assert.equal(active.workflows[0].triggerEvent, 'CUSTOMER_BIRTHDAY_UPCOMING');
});

test('NL Customization: matches "添加低库存自动提醒工作流" to low_stock_alert template', () => {
  resetCustomizationToDefaults();
  const res = nlCustomizationEngine.parseAndApplyNLIntent('添加低库存自动提醒工作流');
  assert.equal(res.success, true);
  assert.equal(res.templateId, 'low_stock_alert');

  const active = getActiveCustomization();
  assert.equal(active.rules.inventoryLowStockThreshold, 15);
});

test('NL Customization: rejects unknown intent gracefully without generating arbitrary code', () => {
  resetCustomizationToDefaults();
  const res = nlCustomizationEngine.parseAndApplyNLIntent('修改系统底层的数据库连接密码');
  assert.equal(res.success, false);
  assert.ok(res.errors && res.errors.length > 0);
  assert.match(res.errors[0], /Could not match intent/i);
});
