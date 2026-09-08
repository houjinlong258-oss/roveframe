import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { simpleParser } from 'mailparser';
import { fetchSquareOrders, mapSquareOrder } from '../src/lib/connectors/square';
import { mapInboundMail } from '../src/lib/email/imap-sync';
import { currencyExponent, mapStripePaymentStatus, toMinorUnits, verifyStripeSignature } from '../src/lib/payments/stripe';
import crypto from 'node:crypto';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('Square sync requires locations, follows cursors, and filters by update watermark', async () => {
  const requests: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    return new Response(JSON.stringify(requests.length === 1
      ? { orders: [{ id: 'one' }], cursor: 'next-page' }
      : { orders: [{ id: 'two' }] }), { status: 200 });
  }) as typeof fetch;
  const rows = await fetchSquareOrders('token', '2026-09-01T00:00:00.000Z', ['L1']);
  assert.deepEqual(rows.map((row) => row.id), ['one', 'two']);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0]?.location_ids, ['L1']);
  assert.match(JSON.stringify(requests[0]), /updated_at/);
  assert.equal(requests[1]?.cursor, 'next-page');
  await assert.rejects(fetchSquareOrders('token', '2026-09-01T00:00:00.000Z', []), /location IDs/);
});

test('Square order adapter exposes the provider ID used by the business-scoped upsert', () => {
  const mapped = mapSquareOrder({ id: 'sq-1', state: 'CANCELED', total_money: { amount: 1250 } });
  assert.equal(mapped.external_id, 'sq-1');
  assert.equal(mapped.order_no, 'SQ-sq-1');
  assert.equal(mapped.total, 12.5);
  assert.equal(mapped.status, 'cancelled');
});

test('Stripe monetary and signature primitives cover production payment lifecycles', () => {
  assert.equal(currencyExponent('JPY'), 0);
  assert.equal(currencyExponent('KWD'), 3);
  assert.equal(toMinorUnits(12.34, 'USD'), 1234);
  assert.equal(mapStripePaymentStatus('succeeded'), 'paid');
  const body = JSON.stringify({ id: 'evt_1' });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac('sha256', 'whsec_test').update(`${timestamp}.${body}`).digest('hex');
  assert.equal(verifyStripeSignature(body, `t=${timestamp},v1=${signature}`, 'whsec_test'), true);
  assert.equal(verifyStripeSignature(`${body} `, `t=${timestamp},v1=${signature}`, 'whsec_test'), false);
});

test('refund, reconciliation, checkout and Square webhook preserve approval, idempotency and scope contracts', () => {
  const approval = readFileSync('src/lib/agent/approvals.ts', 'utf8');
  const refund = readFileSync('src/app/api/payments/refund/route.ts', 'utf8');
  const reconciliation = readFileSync('src/app/api/payments/reconcile/route.ts', 'utf8');
  const checkout = readFileSync('src/app/api/payments/checkout/route.ts', 'utf8');
  const webhook = readFileSync('src/app/api/webhooks/[provider]/route.ts', 'utf8');
  assert.match(refund, /requiredRole: 'owner'/);
  assert.match(refund, /actionType: 'stripe\.refund'/);
  assert.match(approval, /idempotencyKey: `refund:\$\{item\.invocation_id\}`/);
  assert.match(approval, /\.eq\('tenant_id', item\.tenant_id\)\.eq\('business_id', item\.business_id\)/);
  assert.match(reconciliation, /provider amount or currency does not match/);
  assert.match(checkout, /idempotencyKey: `checkout:\$\{paymentId\}`/);
  assert.match(webhook, /integration_events/);
  assert.match(webhook, /event\.event_id/);
  assert.match(webhook, /tenant_id,business_id,source,external_id/);
});

test('IMAP mapping creates a bounded, mailbox-scoped and idempotent inbound record', async () => {
  const parsed = await simpleParser([
    'Message-ID: <m1@example.test>',
    'From: Customer <customer@example.test>',
    'To: Restaurant <owner@example.test>',
    'Subject: Table booking',
    'Date: Mon, 07 Sep 2026 09:00:00 +0800',
    '',
    'Please reserve a table for four.',
  ].join('\r\n'));
  const mapped = mapInboundMail({
    parsed,
    account: { id: 'mailbox-1', tenant_id: 'tenant-a', business_id: 'business-a', email: 'owner@example.test',
      imap_host: 'imap.example.test', imap_port: 993, credentials_encrypted: 'encrypted' },
    externalId: parsed.messageId ?? 'fallback',
    seen: false,
  });
  assert.equal(mapped.tenant_id, 'tenant-a');
  assert.equal(mapped.business_id, 'business-a');
  assert.equal(mapped.mailbox_id, 'mailbox-1');
  assert.equal(mapped.from_addr, 'customer@example.test');
  assert.equal(mapped.status, 'unread');
  const sync = readFileSync('src/lib/email/imap-sync.ts', 'utf8');
  assert.match(sync, /tenant_id,business_id,mailbox_id,external_id/);
});

test('daily briefing delivery resolves only owner subscriptions', () => {
  const worker = readFileSync('src/lib/agent/tasks/worker.ts', 'utf8');
  const scheduler = readFileSync('src/lib/scheduler.ts', 'utf8');
  const push = readFileSync('src/lib/notifications/push.ts', 'utf8');
  const outbox = readFileSync('src/lib/notifications/outbox.ts', 'utf8');
  assert.match(worker, /buildBriefing\(ctx\.tenantId, ctx\.businessId, locale\)/);
  assert.match(worker, /notificationType: 'DAILY_BRIEFING'/);
  assert.match(push, /\.eq\('role', 'owner'\)/);
  assert.match(push, /\.in\('user_id', ownerIds\)/);
  assert.match(outbox, /Unsupported notification channel/);
  assert.match(scheduler, /maybeSyncInboundEmail\(tenant\.id, business\.id\)/);
  assert.match(scheduler, /imap_sync\.\$\{tenantId\}\.\$\{businessId\}/);
});
