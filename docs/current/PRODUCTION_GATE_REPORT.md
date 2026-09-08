# Production Gate Report — 2026-09-07

## Decision

All six P0 engineering gates are **PASS**. The repository is suitable for deployment to a controlled pilot environment after the external checks below. A live restaurant Beta is **NO-GO** until migrations and merchant-owned provider credentials are exercised against an explicitly identified production target.

## P0 gates

| Gate | Result | Evidence |
|---|---|---|
| P0-1 Secret Governance | **PASS** | Secret, legacy-brand, unsafe-global-state, and repository-artifact scans passed across 1,979 source files. Source packaging is allowlisted; environment files and generated/runtime artifacts are excluded. |
| P0-2 Agent Context Isolation | **PASS** | Real Python tool middleware concurrency covered at least 100 mixed tenant/business calls with zero tool, audit, or memory crossover. Unsafe-global-state scan passed. |
| P0-3 Business Data Unification | **PASS** | Eight scoped business domains use the RoveFrame internal adapter through EnterpriseToolGate; canonical prompt and HTTP adapter/E2E contracts passed without a second business database. |
| P0-4 RBAC Enforcement | **PASS** | Source-wide mutation inventory, centralized guard behavior, staff prohibition matrix, required audit behavior, and full API contract suite passed. |
| P0-5 Business Isolation | **PASS** | Business-table inventory and direct-query contract passed; same-tenant/multi-business HTTP and durable state tests showed zero crossover; ambiguous migration backfill fails closed. |
| P0-6 Approval Bus | **PASS** | Frozen-argument hashes, role/expiry/rejection/tamper checks, signed callback, single-use grants, concurrent duplicate callbacks, exact middleware resume, audit, and persistent conversation ownership passed. |

## P1 Restaurant MVP closure

- Square: required Location IDs, full cursor pagination, updated-time ordering, 72-hour delayed/offline overlap, scoped external-ID upsert, exact URL signature verification, and persistent event replay control.
- Stripe: HTTPS/live-key production gate, scoped order-total verification, Checkout and PaymentIntent identities, API idempotency, verified webhook lifecycle, Owner-approved frozen refunds, and amount/currency reconciliation.
- Email: protected IMAP sync, MIME parsing, bounded content, mailbox/Message-ID or UID deduplication, and five-minute scoped polling.
- Briefing: durable AI task plus structured fallback, notification outbox, and Owner-only exact-business Web Push recipients.
- Pilot: `docs/current/RESTAURANT_PILOT_RUNBOOK.md` defines deployment, provider, business-journey, go/no-go, and rollback evidence. ERPNext and PayPal do not block this pilot.

## Final validation evidence

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile --prefer-offline` | PASS |
| `pnpm validate` | PASS: TypeScript, source lint, style lint, 245/245 tests, all production scans |
| Python compileall | PASS |
| Python unit tests | PASS: 13/13 |
| RoveAgent E2E | PASS: signed HTTP approval event, frozen one-use execution, business memory isolation, audit/goal path |
| Production build | PASS: 137 static pages, all dynamic/API routes compiled, `dist/server.js` bundled |
| Diff whitespace check | PASS; only Windows line-ending notices |

## Modified file groups

- Governance/release: `.gitignore`, `.dockerignore`, `.npmignore`, `.env.example`, `.github/`, `package.json`, `pnpm-lock.yaml`, `scripts/production-scan.mjs`, `scripts/package-source.py`, `README.md`.
- Architecture/docs: `docs/current/ARCHITECTURE.md`, `API_PERMISSION_MATRIX.md`, `DATA_SCOPE_MATRIX.md`, `RESTAURANT_PILOT_RUNBOOK.md`, archived superseded reports.
- Identity/RBAC/scope: `src/lib/auth*.ts`, `tenant.ts`, `tenant-db.ts`, `mutation-guard.ts`, protected routes under `src/app/api/`, and schema/migrations.
- Agent/approval/conversation: `src/lib/agent/`, `src/lib/roveagent/`, `src/app/api/agent/`, `roveagent/enterprise/`, `roveagent/api/app.py`, `roveagent/state/`, `roveagent/tools/`.
- P1 integration: `src/lib/connectors/square.ts`, `src/lib/payments/stripe.ts`, `src/lib/email/imap-sync.ts`, provider sync/webhook routes, payment checkout/refund/reconcile routes, email sync/account routes, scheduler, notification outbox/push, settings UI/messages.
- Validation: the existing suites plus `tests/api-rbac-contract.test.ts`, `business-context.test.ts`, `business-isolation.test.ts`, `approval-bus.test.ts`, `production-integrations.test.ts`, Python approval/context/business tests, and `tests/e2e/roveagent_e2e_scenario.py`.

## External incomplete items and known risks

1. Database migration was not applied because no production Supabase target was explicitly selected for this task. Schema behavior therefore has local/static evidence, not live production DDL evidence.
2. No merchant production Square token/location/webhook was supplied. Real cursor volume, delayed offline order, and provider retry delivery remain pilot checks.
3. No authorized Stripe live transaction was supplied. Real Checkout, partial refund, webhook, and reconciliation evidence remain pilot checks; test mode must stay disabled for production.
4. No real IMAP mailbox or consented Owner Web Push subscription was supplied. Provider-specific authentication, inbox round-trip, and device delivery remain pilot checks.
5. Local tests emit third-party deprecation/informational messages (`module.register`, dotenv/report configuration). They do not fail validation or expose secret values, but should be monitored during dependency upgrades.

Follow `RESTAURANT_PILOT_RUNBOOK.md` and attach external IDs/timestamps without credentials before changing the live Beta decision to GO.
