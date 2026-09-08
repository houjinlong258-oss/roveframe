# API Mutation Permission Matrix

This document is the source of truth for write boundaries under `src/app/api/**`.
The executable contract is `tests/api-rbac-contract.test.ts`: a new write route fails CI unless it uses the central mutation guard or is added as an exact, verified boundary exception.

## Role model

| Role | Write authority |
|---|---|
| Owner | Full business control (`*`), including credentials, payments, deployment, user administration, destructive actions, and high-risk outbound actions. |
| Manager | Day-to-day operations, content, customer, reservation, review, notification, Agent use, proposals, customization, and non-destructive staff management. No credentials, payments, deployment, employee deletion, user roles, destructive settings, or outbound campaign/email authority. |
| Staff | Agent use and error/healing capture only among current write APIs. Business records are otherwise read-only. |

## Centrally enforced business mutations

Every row executes: authenticated identity → exact tenant/business scope → permission → durable redacted audit intent → route validation/execution → outcome audit.

| Permission | Owner | Manager | Staff | Routes and methods |
|---|:---:|:---:|:---:|---|
| `agent:use` | Yes | Yes | Yes | `POST /api/agent/chat`; `POST/DELETE /api/agent/sessions`; `POST /api/agent/tools/execute`; `POST /api/enterprise` |
| `approvals:decide` | Yes | Yes | No | `POST /api/agent/approvals` |
| `orders:write` | Yes | Yes | No | `PATCH /api/business/orders` |
| `products:write` | Yes | Yes | No | `POST/PATCH /api/business/products`; `POST /api/business/products/generate`; `POST/PATCH/DELETE /api/store/qr-codes`; `POST /api/upload` |
| `customers:write` | Yes | Yes | No | `POST /api/customers/score` |
| `reviews:write` | Yes | Yes | No | `PATCH /api/reviews`; `POST /api/reviews/reply` |
| `reservations:write` | Yes | Yes | No | `POST/PATCH /api/reservations` |
| `knowledge:read` | Yes | Yes | No | `POST /api/knowledge/ask` (read-only semantic query with model usage and audit) |
| `knowledge:write` | Yes | Yes | No | `POST/PATCH/DELETE /api/knowledge/docs` |
| `marketing:write` | Yes | Yes | No | `POST/PATCH/DELETE /api/marketing/contents`; `POST /api/marketing/generate` |
| `marketing:send` | Yes | No | No | `POST /api/marketing/send` |
| `emails:write` | Yes | Yes | No | `PATCH /api/emails`; `POST /api/emails/classify`; `POST /api/emails/sync` |
| `emails:send` | Yes | No | No | `POST /api/emails/send` |
| `channels:write` | Yes | Yes | No | `POST /api/channels/send`; `POST /api/channels/test` |
| `notifications:write` | Yes | Yes | No | `PATCH /api/notifications`; `POST/DELETE /api/notifications/push`; `PATCH /api/alerts` |
| `staff:write` | Yes | Yes | No | `POST /api/business/staff` |
| `staff:delete` | Yes | No | No | `DELETE /api/business/staff` |
| `integrations:write` | Yes | No | No | `POST/DELETE /api/integrations`; `POST /api/integrations/test`; `POST /api/integrations/[provider]/sync`; `POST/DELETE /api/channels` |
| `payments:write` | Yes | No | No | `POST /api/payments/checkout`; `POST /api/payments/refund`; `POST /api/payments/reconcile` |
| `settings:write` | Yes | No | No | `PUT /api/settings`; `DELETE /api/settings/wipe`; `POST/DELETE /api/settings/models`; `POST /api/settings/models/test`; `POST/DELETE /api/settings/email-accounts` |
| `coding:propose` | Yes | Yes | No | `POST/PATCH /api/coding-agent` |
| `coding:apply` | Yes | No | No | `POST /api/coding-agent/apply`; `POST /api/coding-agent/rollback` |
| `deployment:write` | Yes | No | No | `POST /api/deployment` |
| `customization:write` | Yes | Yes | No | `POST /api/customization` |
| `healing:write` | Yes | Yes | Yes | `POST /api/healing` |

## Centrally enforced tenant mutations

| Permission | Owner | Manager | Staff | Routes and methods |
|---|:---:|:---:|:---:|---|
| `users:write` | Yes | No | No | `POST /api/auth/invite` (user creation and role assignment) |
| `settings:write` | Yes | No | No | `POST /api/onboarding/confirm` (tenant/business bootstrap confirmation) |

## Exact boundary exceptions

These routes do not use merchant RBAC because their caller identity or semantics belong to a different trust boundary. They remain part of the executable route inventory.

| Boundary | Routes and methods | Required control |
|---|---|---|
| Platform administration | `POST /api/admin/tenants`; `PATCH /api/admin/tenants/[id]`; `POST /api/admin/subscriptions`; `POST /api/admin/support-access` | Independent platform-admin session, platform roles, and platform audit via `adminHandler`. |
| Platform session | `POST/DELETE /api/admin/auth` | Independent admin credential/session flow and platform audit. |
| Append-only audit | `POST/PUT/PATCH/DELETE /api/admin/audit-logs` | Always returns 405; no mutation implementation exists. |
| Merchant session | `POST /api/auth/login`; `POST /api/auth/signup`; `POST /api/auth/logout` | Login/bootstrap/cookie-removal semantics; no existing merchant session can be required. |
| RoveAgent internal service | `POST /api/internal/agent/business-data`; `POST /api/agent/approvals/events` | Non-empty shared service key compared in constant time plus exact tenant/business verification. |
| Provider webhook | `POST /api/webhooks/[provider]` | Provider signature verification and replay/idempotency control before mutation. |
| Public storefront | `POST/PATCH /api/store/orders` | Opaque active store token, server-side prices, scoped records, and idempotency. |
| Customer device | `POST/DELETE /api/customer/favorites` | Random device cookie scopes the caller's own preference records; no merchant authority is exposed. |
| Side-effect-free parser | `POST /api/onboarding/parse` | Bounded input and no persistence or external side effect. |

## Sensitive-operation decisions

- Product price and cost share `products:write`; staff does not have it.
- Integration secrets and provider connections require `integrations:write`; only Owner has it.
- Employee deletion is separate from staff maintenance and requires `staff:delete`; only Owner has it.
- User creation/role assignment requires tenant-level `users:write`; only Owner has it.
- Payment creation, refund requests, and reconciliation require `payments:write`; only Owner has it. Refund requests additionally freeze the PaymentIntent and amount in the unified Approval Bus before Stripe is called.
- Code application, rollback, and deployment are Owner-only and additionally require the unified Approval Bus before P0-6 can pass.
- Outbound campaigns and email sending are Owner-only and additionally require the unified Approval Bus before P0-6 can pass.
