# RoveFrame AI Business OS Architecture

This document is the architecture source of truth for the production system.

## System boundary

RoveFrame is the product and control plane. It owns the Next.js SaaS, verified authentication, tenant and business membership, role-based access control, business records, approval records and UI, audit, billing, integrations, public storefront, and product-facing APIs.

RoveAgent Core is the intelligence and execution plane. It owns Agent loop behavior, reasoning orchestration, tool selection, skills, memory, subagents, planning, scheduled AI work, and business-action execution. It does not own a second database of business facts.

```text
User or scheduled task
        |
        v
RoveFrame authenticated API / scheduler
        |
        v
Immutable Agent run context
        |
        v
RoveAgent Core planner and Agent loop
        |
        v
Enterprise Tool Gate
  schema -> scope -> permission -> risk -> approval -> execution -> audit
        |
        v
RoveFrame Business Tool Adapter
        |
        v
Supabase business tables and approved external integrations
```

## Identity and scope

RoveFrame verifies the browser session or bearer token on the server. Caller-provided tenant or role headers are stripped before verified headers are injected. Public storefront access is scoped by an opaque QR/store token rather than a caller-selected tenant.

Every Agent run and tool call uses an immutable context containing:

- `tenant_id`
- `business_id`
- `user_id`
- `role`
- `permissions`
- `request_id`
- `task_id`

Scope is created by the trusted request or scheduler boundary. Model arguments and individual tools cannot override it. Business-scoped reads and writes require both tenant and business predicates; tenant-only data must be explicitly classified as such.

## Business data source of truth

Supabase RoveFrame business tables are authoritative for revenue, orders, customers, products, inventory, reviews, payments, reservations, marketing, email, integrations, and business profile data. RoveAgent Core accesses these facts only through the Enterprise Tool Gate and the RoveFrame Business Tool Adapter.

RoveAgent Core may persist Agent state, execution state, task state, conversations, summaries, long-term memory, and skill metadata. These records are always partitioned by tenant and business where they are business-specific.

## Authorization boundary

Protected API mutations use one centralized sequence:

1. Authenticate the request.
2. Resolve verified tenant, business, user, and role.
3. Require the route's permission.
4. Validate the input schema.
5. Execute a tenant/business-scoped operation.
6. Record a redacted audit event.

Security failures fail closed. Staff cannot modify financial configuration, integration credentials, user roles, destructive staff state, product prices/costs, deployment, refunds, or other owner-only controls.

## Agent tool boundary

Every model-callable business tool is registered with name, description, input schema, required permissions, risk level, approval policy, and audit category. There is no direct model-to-database or model-to-side-effect path.

Read-only business analytics may execute without approval after permission checks. Refunds, payments, campaign or bulk email sends, customer mutations, deployments, code changes, credential changes, deletes, and external publishing require the configured human approval policy.

## Approval bus

RoveFrame's `agent_approvals` workflow is the single approval system for business actions. A pending record freezes the original tool name and validated arguments with tenant, business, requester, Agent, risk, role, request/task, expiry, and execution identity.

Approval is single-use, idempotent, and business-scoped. Approval resumes the stored invocation; the model is never asked to regenerate arguments. Rejection and expiry can never execute the action. Execution and final state are audited, and signed service callbacks are authenticated without logging credentials.

## Conversations and memory

Cross-request chat is persisted by conversation ID, tenant, business, and user. Prompt construction is bounded to recent turns, a rolling summary, retrieved long-term enterprise memory, current business context, and the selected industry skill. Full unbounded transcripts are not appended to every model request.

## Public and external boundaries

Public menu/order routes resolve an opaque storefront token to exactly one tenant and business. Server-side pricing is authoritative. External webhooks require signature verification, bounded timestamps where supported, and persistent idempotency before side effects.

Square order ingestion uses required location IDs, cursor pagination, an overlapping update watermark for delayed offline POS uploads, and `(tenant, business, provider, external_id)` uniqueness. Square webhook receipts are persisted by provider event ID before an atomic scoped order upsert.

Stripe Checkout uses HTTPS/live-key production validation, server-verified order amounts, API idempotency keys, and separate Checkout Session and PaymentIntent references. Refunds execute only from a frozen Owner approval. Reconciliation verifies provider amount and currency before updating local state. Stripe webhook receipts remain retryable until processing completes.

Inbound email is pulled through bounded IMAP reads, parsed as MIME, and deduplicated by mailbox plus Message-ID/UID identity. Daily AI briefings use the durable Agent task and notification outbox, with Web Push delivery restricted to verified Owner subscriptions for the exact business.

Credentials are encrypted at rest, excluded from logs and audit payloads, and never included in source archives. `.env.example` contains placeholders only.

## Deployment and validation

The JavaScript workspace uses pnpm exclusively. CI installs from the lockfile and runs TypeScript, lint, unit/API/security tests, Python compilation/tests, RoveAgent E2E coverage, build verification, and production scans. Database migrations and external integration tests require an explicitly identified target environment and never run implicitly during a source build.

Third-party licensing and source attribution are retained only in designated legal files and directories.
