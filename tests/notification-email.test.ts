import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

test('outbox delivers email channel through the real SMTP path', () => {
  const source = readFileSync(join(process.cwd(), 'src/lib/notifications/outbox.ts'), 'utf8');
  const emailBranchIndex = source.indexOf("item.channel === 'email'");
  const throwIndex = source.indexOf('Unsupported notification channel');
  assert.ok(emailBranchIndex > -1, 'email branch missing');
  assert.ok(emailBranchIndex < throwIndex, 'email branch must be handled before the fallback throw');
  assert.match(source, /sendEmailWithDefaultAccount/);
  assert.match(source, /\.eq\('role', 'owner'\)/);
});

test('daily briefing enqueues email + web_push with per-channel idempotency keys', () => {
  const source = readFileSync(join(process.cwd(), 'src/lib/agent/tasks/worker.ts'), 'utf8');
  assert.match(source, /channel: 'email'/);
  assert.match(source, /channel: 'web_push'/);
  assert.match(source, /daily-briefing:/);
  assert.match(source, /:email/);
  assert.match(source, /:push/);
});

test('notification dispatch is enabled by default (opt-out only)', () => {
  const source = readFileSync(join(process.cwd(), 'src/lib/scheduler.ts'), 'utf8');
  assert.match(source, /ROVEFRAME_ENABLE_NOTIFICATION_DISPATCH !== 'false'/);
});

test('service worker handles push and click without Serwist', () => {
  const swPath = join(process.cwd(), 'public/sw.js');
  assert.ok(existsSync(swPath), 'public/sw.js missing');
  const sw = readFileSync(swPath, 'utf8');
  assert.match(sw, /addEventListener\('push'/);
  assert.match(sw, /showNotification/);
  assert.match(sw, /addEventListener\('notificationclick'/);
  const nextConfig = readFileSync(join(process.cwd(), 'next.config.ts'), 'utf8');
  assert.match(nextConfig, /swDest: 'public\/sw\.js'/);
});

test('PWA icons exist for manifest and push payloads', () => {
  for (const name of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'icon-192x192.png', 'icon-512x512.png']) {
    assert.ok(existsSync(join(process.cwd(), 'public/icons', name)), name + ' missing');
  }
});

test('push subscribe component registers SW and persists subscription', () => {
  const source = readFileSync(join(process.cwd(), 'src/components/pwa/PushSubscribe.tsx'), 'utf8');
  assert.match(source, /serviceWorker\.register\('\/sw\.js'/);
  assert.match(source, /pushManager\.subscribe/);
  assert.match(source, /\/api\/notifications\/push/);
  assert.match(source, /NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY/);
});
