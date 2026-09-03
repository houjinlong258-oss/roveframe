import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { pluginRegistry } from '../src/lib/plugins/registry';
import { PluginManifest } from '../src/lib/plugins/types';

beforeEach(() => {
  pluginRegistry.clear();
});

test('Plugin System: registers valid plugin manifest successfully', () => {
  const manifest: PluginManifest = {
    id: 'birthday_discount',
    name: 'Birthday Discount Feature',
    version: '1.0.0',
    type: 'business_feature',
    description: 'Provides birthday discounts for loyal customers',
    permissions: ['orders.read', 'customers.read'],
    files: ['custom/components/birthday-discount.tsx'],
  };

  const res = pluginRegistry.registerPlugin(manifest);
  assert.equal(res.success, true);

  const registered = pluginRegistry.getPlugin('birthday_discount');
  assert.ok(registered);
  assert.equal(registered.manifest.name, 'Birthday Discount Feature');
});

test('Plugin System: rejects manifest attempting to access core paths', () => {
  const maliciousManifest: PluginManifest = {
    id: 'malicious_plugin',
    name: 'Malicious Plugin',
    version: '1.0.0',
    type: 'business_feature',
    description: 'Attempts core access',
    permissions: ['orders.read'],
    files: ['src/core/auth/secret.ts'],
  };

  const res = pluginRegistry.registerPlugin(maliciousManifest);
  assert.equal(res.success, false);
  assert.ok(res.errors && res.errors.length > 0);
  assert.match(res.errors[0], /forbidden core path/i);
});

test('Plugin System: checks plugin permissions correctly', () => {
  const manifest: PluginManifest = {
    id: 'reviews_auto_reply',
    name: 'Reviews Auto Reply Plugin',
    version: '1.0.0',
    type: 'workflow_addon',
    description: 'Drafts responses for positive customer reviews',
    permissions: ['reviews.read', 'reviews.write'],
    files: ['custom/plugins/reviews-auto-reply.ts'],
  };

  pluginRegistry.registerPlugin(manifest);

  assert.equal(pluginRegistry.hasPermission('reviews_auto_reply', 'reviews.read'), true);
  assert.equal(pluginRegistry.hasPermission('reviews_auto_reply', 'orders.write'), false);

  const matchingPlugins = pluginRegistry.findByPermission('reviews.write');
  assert.equal(matchingPlugins.length, 1);
  assert.equal(matchingPlugins[0].manifest.id, 'reviews_auto_reply');
});
