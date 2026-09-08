# Restaurant Production Pilot Runbook

This runbook is the go/no-go checklist for the first live restaurant. ERPNext and PayPal are deliberately outside the pilot gate.

## 1. Release inputs

- A dedicated production Supabase project with backups, point-in-time recovery, and no demo tenant data.
- A public HTTPS application URL and an internal HTTPS RoveAgent URL.
- Unique production values for every placeholder in `.env.example`. Never copy test or staging secrets.
- One restaurant business record, one verified Owner user, and only the staff accounts needed for the pilot.
- Square production Access Token, one to ten Location IDs, webhook signature key, and the exact notification URL saved in the Square integration configuration.
- Stripe live secret key and webhook secret. `STRIPE_ALLOW_TEST_MODE` must be unset in production.
- A mailbox with IMAP and SMTP enabled, least-privilege credentials or OAuth token, and provider-side access controls.
- VAPID keys and an Owner device with notification permission granted.

## 2. Database deployment

1. Take a database backup and record its recovery point.
2. Run the repository migration preflight against the intended project.
3. For a new database, apply `scripts/migrate-business-tables.sql` first, then `scripts/migrate.sql`. For an existing deployment with the base tables, apply `scripts/migrate.sql`. Do not cherry-pick individual statements.
4. Confirm the unique business/provider, order external-ID, webhook event, payment reference, approval invocation, and inbound email indexes exist.
5. Confirm legacy rows have unambiguous `tenant_id` and `business_id`. Stop if any backfill guard raises an ambiguity error.

## 3. Provider setup

### Square

1. Save the Access Token, comma-separated Location IDs, signature key, and exact webhook URL in Settings.
2. Subscribe to `order.created` and `order.updated`.
3. Run one manual sync. Confirm all cursor pages complete and `last_sync_at` advances.
4. Send the same signed webhook twice. The first must update the order; the second must return `duplicate: true` without a second order.
5. Create an offline POS order, reconnect the device, and confirm the 72-hour overlap imports it.

### Stripe

1. Save the live secret key and webhook signing secret.
2. Subscribe to Checkout Session, PaymentIntent, and refund/charge lifecycle events used by the webhook route.
3. Create a low-value hosted Checkout payment and complete it with an approved production payment method.
4. Confirm the local payment records both Checkout Session ID and PaymentIntent ID and becomes `paid` only after verified provider state.
5. Request a partial refund. Confirm it creates an Owner approval and makes no Stripe call before approval.
6. Approve once, repeat the approval request, and confirm Stripe receives one idempotent refund.
7. Run reconciliation and confirm amount and currency match before local status changes.

### Email and Owner notification

1. Save IMAP/SMTP host, ports, username, and credential/OAuth token. Trigger inbox sync twice and confirm the second run creates no duplicate messages.
2. Send and reply to a real message in each supported language.
3. Register the Owner PWA subscription. Run the daily briefing task and notification dispatcher.
4. Confirm only Owner subscriptions receive the briefing; manager/staff subscriptions must not receive it.

## 4. Restaurant journey acceptance

- Scan every table QR code and confirm the table token cannot select another business.
- Place dine-in orders, update/cancel at the POS, and confirm dashboard totals, inventory signals, reviews, customers, and payment summaries stay within the pilot business.
- Exercise Owner, Manager, and Staff accounts against the permission matrix. Staff must not access settings, integrations, payments, refunds, or approvals.
- Start an Agent conversation, continue it in a separate request, and verify business facts and memory remain scoped to the same tenant/business/user.
- Trigger one high-risk Agent action, reject it, then trigger another and approve it. Verify frozen arguments, audit record, and single execution.

## 5. Go/no-go and rollback

Go live only when the full repository validation suite, Python suite, build, production scans, signed webhook replays, real Stripe payment/refund, real Square order sync, IMAP round-trip, and Owner notification all pass.

Stop and roll back traffic if tenant/business scope is ambiguous, a signature cannot be verified, a webhook replays a side effect, a payment amount differs from Stripe, an approval executes twice, or secrets appear in logs/artifacts. Disable provider integrations first, preserve webhook/audit records, restore the recorded database recovery point if data integrity changed, and redeploy the last verified application release.

Record external evidence for the release: deployment commit, migration timestamp, Supabase project identifier, Square event/order IDs, Stripe session/PaymentIntent/refund IDs, IMAP Message-ID, notification delivery result, test output, operator, and UTC timestamps. Store no credentials in the evidence bundle.
