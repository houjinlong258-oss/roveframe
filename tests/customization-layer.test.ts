import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getActiveCustomization,
  updateActiveCustomization,
  resetCustomizationToDefaults,
} from '../src/custom/loader';

test('Customization Layer: loads core defaults correctly', () => {
  resetCustomizationToDefaults();
  const customization = getActiveCustomization();
  assert.equal(customization.theme.brandName, 'ROVE/FRAME');
  assert.equal(customization.theme.accentColor, '#A7FF00');
  assert.equal(customization.rules.inventoryLowStockThreshold, 10);
  assert.equal(customization.workflows.length, 1);
});

test('Customization Layer: dynamically applies tenant overrides with fallback', () => {
  resetCustomizationToDefaults();
  updateActiveCustomization({
    theme: { brandName: 'Custom Bistro / OS', primaryColor: '#121212', accentColor: '#A7FF00', nearBlack: '#0D0D0D', warmOffWhite: '#F7F5F0', borderRadius: '0.5rem' },
    rules: { inventoryLowStockThreshold: 15, revenueDropAlertPercent: 25, reviewWinBackHours: 24, customRuleFlags: { enableAutoWinBackEmailDraft: true } },
  });

  const customization = getActiveCustomization();
  assert.equal(customization.theme.brandName, 'Custom Bistro / OS');
  assert.equal(customization.rules.inventoryLowStockThreshold, 15);
  assert.equal(customization.rules.revenueDropAlertPercent, 25);
});
