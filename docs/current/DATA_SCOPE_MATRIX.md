# RoveFrame Data Scope Matrix

This document is the production data-boundary contract. It complements
`ARCHITECTURE.md`; route and tool implementations must follow these scopes even
when the service-role database client bypasses row-level security.

## Business-scoped operational data

Every read and mutation requires both `tenant_id` and `business_id`:

| Domain | Tables |
| --- | --- |
| Commerce | `products`, `orders`, `customers`, `reviews`, `staff`, `reservations`, `inventory_items` |
| Storefront | `store_qr_codes` |
| Knowledge and conversations | `knowledge_docs`, `doc_chunks`, `business_memories`, `chat_sessions`, `chat_messages` |
| Communications | `marketing_contents`, `emails`, `email_accounts`, `email_send_tasks`, `alerts` |
| Configuration | `integration_configs`, `model_configs`, `settings` |
| Payments and provider events | `payments`, `payment_events`, `integration_events` |
| Agent operations | `agent_actions`, `agent_approvals`, `agent_tasks`, `agent_task_runs`, `agent_events` |
| Notifications | `notification_outbox`, `notifications`, `push_subscriptions` |

Application code uses `scopedTable`, `insertWithScope`, `updateWithScope`, or
`deleteWithScope`. These helpers reject a missing business scope. The legacy
tenant-only helpers reject every table above.

Provider configuration is unique by `(tenant_id, business_id, provider)`, so
two businesses in one tenant can connect separate Square, Stripe, email, or AI
provider accounts without ambiguous `maybeSingle` results.

## Tenant or platform scoped control data

| Scope | Tables / purpose |
| --- | --- |
| Platform | `platform_admins`, admin sessions, subscription plans, deployment/control-plane records |
| Tenant control | `tenants`, `businesses`, `users`, `roles`, `user_roles`, tenant lifecycle audit |
| Mixed telemetry | `audit_logs` and `ai_usage_ledger`; business-originated records carry business scope, while platform lifecycle records may not |
| Scheduler control | `cron_state`; keys include the business identifier for business jobs |

Cross-business reads are permitted only in authenticated platform-admin views
or internal schedulers that enumerate businesses and then execute each unit of
work with an exact tenant/business pair. They are not merchant API paths.

## Public and service boundaries

- Public store routes accept only the opaque QR/store token. The server resolves
  that token to one tenant/business pair before reading or writing data.
- Provider webhooks require tenant and business routing identifiers, load the
  signing secret for that exact pair, verify the provider signature, and then
  mutate only the same pair.
- RoveAgent internal business-data requests carry tenant and business scope and
  the response scope must match before data is accepted.
- RoveAgent task, memory, conversation, and approval state is also partitioned
  by tenant and business. Conversations additionally bind the user.

## Legacy migration rule

The migration may infer `business_id` only when a tenant has exactly one
business. If an existing tenant has multiple businesses and an operational row
has no business identifier, migration aborts with `business scope backfill
required`. An operator must map those rows explicitly; the migration never
guesses which business owns them.
