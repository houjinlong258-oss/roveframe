# RoveAgent architecture — executable extraction v0.1

## Current executable path

Authenticated chat API → existing tenant/business context, industry prompt and
memory → application gateway → RoveAgent Core → scoped provider router →
enterprise tool registry → tool observations → next planning round → answer/SSE.

`packages/roveagent-core` is TypeScript source with zero runtime dependencies.
The application adapter imports it directly, so no Python process, upstream
gateway or personal configuration directory is involved. The package can be
transpiled independently. It does not import application storage or credentials.

## Runtime contract

- Planner receives observations from earlier rounds and returns calls or an answer.
- Executor owns permission, schema validation, approval and awaited audit.
- Runtime owns call budgets, duplicate detection, cancellation checks and stop state.
- Default limit: four planning rounds and four tool executions per chat request.
- Unsupported native tool providers retain the existing single-plan fallback.
- A pending approval stops further execution. Approval is not inferred from an
  AI employee's title or model-generated message.
- Duplicate name/arguments are suppressed across the entire request. This is
  not durable exactly-once execution across HTTP retries; business operations
  still require the existing persisted approval/idempotency mechanisms.
- Cancellation prevents subsequent planning/execution; it cannot undo an
  already issued tool operation or abort a provider call without adapter support.
- Tool observations are bounded for model context and labelled as untrusted data.
  The existing system prompt remains unchanged throughout the request.

## Enterprise authority

Tenant identity, business identity, user role and audit context remain
server-created. Model parameters never replace this scope. Existing auth,
RBAC, payments, POS connectors and approval routes remain the authority.
Existing six role definitions remain in the enterprise layer; this extraction
does not imply that those roles already collaborate autonomously.

## Workforce evolution still required

| Capability | Current state | Required upgrade |
| --- | --- | --- |
| Business planning | Result-dependent tool loop | Durable goals, milestones, measurable outcomes, human escalation |
| Employee identity | Existing six role definitions | Finance/inventory roles, role-specific skills, cost limits and persisted metrics |
| Enterprise memory | Existing application context and Supabase memory | L0–L4 publication rules, customer/conversation scope, expiry, permission-aware ranking |
| Skills | Existing industry prompt selection | Approved versioned skill packages with schema, workflow and evaluation contracts |
| Coordination | No new autonomous delegation | Durable dependency graph, attenuated permissions and shared financial budget |
| Scheduler/channels | Existing independent application implementations | Bind approved durable workflows to event and channel ingress |
| Learning | Existing conversational memory extraction | Evidence-backed outcome evaluation; no self-granting permissions or automatic code changes |

## Operational impact

Complex questions can now make up to four planning requests instead of one.
Provider usage continues through the existing scoped usage ledger. This is a
bounded call-count policy, not a dollar budget. The impact on model latency and
cost needs measurement using configured providers and realistic tenant data.
Source-size reduction does not establish inference performance improvements.
