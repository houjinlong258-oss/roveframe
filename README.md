<div align="center">

<img src="docs/assets/logo.jpg" alt="RoveFrame" width="420" />

# RoveFrame AI Business OS

**AI-native business operating system powered by multi-agent workflows.**

Agents do the work. Humans keep the authority.

**English** · [简体中文](README.zh-CN.md) · [Español](README.es.md)

[![CI](https://github.com/houjinlong258-oss/roveframe/actions/workflows/ci.yml/badge.svg)](https://github.com/houjinlong258-oss/roveframe/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-5_strict-3178C6?logo=typescript&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![Python](https://img.shields.io/badge/Python-3.11--3.13-3776AB?logo=python&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-Postgres_%2B_RLS-3FCF8E?logo=supabase&logoColor=white)

</div>

---

## Overview

RoveFrame is an **AI business operating system** for small businesses. It is not a chatbot
wrapped around a dashboard: it is an execution platform where LLM agents observe real
business data, propose concrete actions, and — only after a human approves them — execute
those actions against real systems, leaving an audit trail behind.

The first vertical is a restaurant: orders, menus, customers, staff, delivery, reservations,
marketing and email, all in one operational surface. The architecture underneath is
vertical-agnostic — business rules live in configuration and prompt layers, not in hard-coded
branches.

RoveFrame is the product and **control plane**; **RoveAgent Core** is the intelligence and
execution plane. They are separate processes with a narrow, authenticated contract between them.

**The design problem this project solves** is the one that separates a demo from a system: an
LLM that can *act* is a liability unless you can answer four questions about every action it
takes.

| Question | How this system answers it |
|---|---|
| Who is allowed to do this? | Role/permission matrix plus per-agent tool namespaces, resolved server-side, deny by default |
| Was a human in the loop? | Approval objects with **frozen arguments**, owner-gated, with visible execution status |
| What actually happened? | Durable audit rows written *before* execution and after the outcome — a failed audit write fails the operation |
| How do we know it works? | A live-database test suite, a schema-drift preflight, and machine-validated alert rules (see [Engineering practices](#engineering-practices)) |

<div align="center">
<img src="docs/assets/architecture-overview.png" alt="RoveFrame architecture overview" width="900" />
</div>

---

## Key Features

**Multi-agent orchestration.** Named agent roles (CEO, Operations, Marketing, Customer,
Developer, DevOps) each receive an explicit tool namespace and capability tier. A role can only
reach the tools it was granted, and that gate is enforced in code — not by asking the model
politely in a prompt.

**Agent workflow engine.** A durable task queue with atomic claims (`FOR UPDATE SKIP LOCKED`),
lease recovery for crashed workers, retry budgets, and per-tick scheduling. Long-running work
does not live inside an HTTP request.

**Tool registry.** Tools are declared with an input schema, a required permission and a risk
level, then invoked through a single runtime that applies the gates in a fixed order —
**permission → audit → execution** — with a timeout and an outcome record.

**Permission control.** A role/permission matrix resolved from the database, plus a second
namespace check per agent role. Requests carry verified tenant and business context, and every
data access is scoped by it. Model-supplied arguments can never choose that scope.

**Approval workflow.** Sensitive actions (refunds, bulk sends, deployments) create an approval
instead of executing. Arguments are frozen at request time, so the thing approved is exactly the
thing executed. Approvals are owner-gated, expire, and are auditable.

**Human-in-the-loop validation.** Agents surface *proposals*, not *fait accompli*: an operator
sees the recommendation, the reasoning and the exact payload before anything irreversible runs.

**Audit logging.** Every privileged mutation writes a durable intent record before execution and
an outcome record afterwards. If the audit store is unavailable, the operation fails closed
rather than proceeding unrecorded.

**LLM integration.** A provider-agnostic routing layer with per-capability model assignment
(`agent` / `content` / `rag` / `light`), failover across providers, and a platform fallback so
the product still works before a customer connects their own key. Credentials are encrypted at
rest with AES-256-GCM.

**Workflow automation.** A scheduler drives recurring work: daily executive briefs, anomaly
alerts, inbound email sync, outbound send queues, web-push delivery, delivery-position retention
purges, and task-queue polling.

**Multi-tenant by construction.** Tenant and business scope is not a convention: it is injected
by the network boundary, re-checked in the handler, enforced again by the data-access helpers,
and finally backstopped by Postgres row-level security.

**Trilingual product surface.** English, Chinese and Spanish, with a key-parity test that fails
the build when a translation drifts.

---

## Product Surface

Four views of the product — from the owner's command centre down to the module set. Each panel is
shown full width so the detail is readable; every one maps to a real route in this repository.

> **What these are.** Product overview graphics rendered from the application's own screens —
> not captures of a live deployment. The platform has no public origin yet (`app.roveframe.ai` in
> the mockup chrome is a design placeholder), and the panels show an empty workspace on purpose,
> so no customer data is ever depicted. Real, unedited screenshots belong in `docs/screenshots/`,
> which is still empty and says why — see [that note](docs/screenshots/README.md).

### Command centre and the AI COO

<img src="docs/assets/product-overview.png" alt="Command centre, AI COO assistant and system integration" width="100%" />

The owner's morning brief: what the AI team did overnight, revenue / orders / customers /
conversion — with an honest `no comparative data` state instead of an invented delta — and the
agent roster (CEO, Operations, Marketing, Customer) with per-agent activity. Beside it, the AI COO
assistant drafts and reasons over the same data. → `src/app/[locale]/dashboard`, `agent`

### Operations modules

<img src="docs/assets/operations-modules.png" alt="Business data, reservations, team management and the AI website builder" width="100%" />

The daily operational surface: business data (products, orders, inventory), reservations with a
live status calendar, team management with roles, access control and the workforce centre
(benefits, attendance exceptions, care tasks), and the AI website builder for a public storefront
with custom domain and online ordering. → `business`, `reservations`, `team`, `website`

### Integrations and the control layer

<img src="docs/assets/integrations-control-layer.png" alt="Integrations and the configuration control layer" width="100%" />

One place to connect the outside world and to bound what the agents may do: delivery-map provider,
third-party service credentials, AI model access (per-capability routing), ERPNext connectivity,
POS and payment connectors — alongside outbound and inbound mailbox setup, send rate and daily
caps, and the switches for customer auto-reply, anomaly push and the daily brief.
→ `settings`

### Content and customer intelligence

<img src="docs/assets/content-customer-intelligence.png" alt="File centre, knowledge brain, review intelligence and email centre" width="100%" />

The knowledge and communication surfaces: a file centre for uploads and AI-generated reports, a
knowledge brain answering from your own SOPs and policies with citations, review intelligence with
sentiment analysis and reply drafting, and an email centre that classifies incoming mail into
inquiry / opportunity / complaint / supplier / other.
→ `files`, `knowledge`, `reviews`, `emails`

---

## System Architecture

The system is two planes with one contract.

```
Human User
    ↓  natural language · files · project context
Application Layer            Next.js 16 (App Router, React 19, TypeScript strict)
    ↓  task request
Agent Orchestration Layer    RoveAgent Core — FastAPI runtime, capability registry & router
    ↓  assign & coordinate
Specialized Agents           CEO · Operations · Marketing · Customer · Developer · DevOps
    ↓  use tools & data
Tools / APIs / Data Layer    internal tools · connectors · knowledge base · web search · Postgres
    ↓  results & evidence
Human Validation             review · approve · request changes · continue iteration
    ↺  feedback loop  →  audit & memory  →  better next time
```

**Control plane** (`src/`) — the product surface, the tenant and identity model, the approval and
audit system, and the entire data-access layer. Every HTTP entry point passes through a single
network boundary that authenticates the session, strips client-forged context headers, and
injects verified `tenant_id` / `business_id` / `role` for downstream handlers.

**Execution plane** (`roveagent/`) — the Python runtime that owns the agent loop, capability
discovery, provider failover, tool execution and streaming. It is a separate process on an
internal-only port; the web tier talks to it with a shared key plus HMAC-signed callbacks.

The boundary between them is deliberately narrow: the web tier never executes model-driven
actions itself, and the runtime does not hold privileged write access to business tables.

### Data flow of one agent action

```
1. Request      → proxy authenticates, strips forged headers, injects verified scope
2. Handler      → central mutation guard: entitlement → tenant scope → permission
3. Intent       → durable audit row written BEFORE execution (failure ⇒ 503, fail closed)
4. Agent        → runtime resolves capability → tool registry → schema validation
5. Approval     → if the action is sensitive: frozen-argument approval, owner-gated
6. Execution    → tool runs under a timeout; result recorded
7. Outcome      → audit row written AFTER execution (failure ⇒ reported, never silent)
8. Evidence     → UI shows status; metrics expose counters; alert rules watch the backlog
```

---

## Agent Development Workflow

This repository is itself an example of AI-native engineering: humans own architecture and
judgement, agents own breadth and iteration speed.

```mermaid
flowchart TD
    H1["Human — architecture decisions, product requirements"] --> O["Orchestration layer<br/>RoveAgent Core — upstream agent-runtime lineage (MIT)"]
    O --> CC["Claude Code — codebase analysis, task decomposition, review"]
    O --> CX["Codex — implementation assistance"]
    O --> GM["Gemini CLI — frontend iteration"]
    CC --> H2["Human — testing and validation"]
    CX --> H2
    GM --> H2
    H2 -->|"findings become new tasks"| O
```

| Stage | Who | What they own |
|---|---|---|
| Direction | Human | Architecture, data model, security boundaries, product requirements |
| Orchestration | Multi-agent runtime | Routing work, holding context, coordinating specialised agents |
| Analysis | Claude Code | Reading the codebase, decomposing tasks, adversarial review of the result |
| Implementation | Codex | Scoped implementation against a defined contract |
| Frontend iteration | Gemini CLI | UI construction and visual iteration |
| Verification | Human | Running the gates, judging evidence, accepting or rejecting the outcome |

The non-negotiable rule in this loop: **an agent's claim is not evidence until a command proves
it.** Every guard in this repository is required to fail when the thing it guards is broken — a
check that cannot fail is treated as a defect, not as coverage.

---

## Technical Stack

**Frontend**

| Technology | Role |
|---|---|
| Next.js 16 (App Router) | Routing, server components, route handlers, custom server entry |
| React 19 | UI |
| TypeScript 5 (strict) | Whole-app type safety, no implicit `any` |
| Tailwind CSS 4 + shadcn/ui (Radix) | Design system, 50+ UI primitives |
| next-intl | en / zh / es with key-parity enforcement |
| Serwist | PWA service worker (currently disabled on Turbopack — see `next.config.ts`) |
| Recharts · react-markdown | Dashboard charts, streaming agent output |

**Backend**

| Technology | Role |
|---|---|
| Next.js route handlers | 132 API handlers |
| Node custom server (`src/server.ts`) | Scheduler, boot preflight, auto-migration, process-level guards |
| Python 3.11–3.13 · FastAPI · uvicorn | RoveAgent Core execution plane |
| TypeScript agent-runtime primitives | Iteration budget, repetition guard, tool-call canonicalisation |
| zod | Every request body and tool input schema |

**Data**

| Technology | Role |
|---|---|
| Supabase Postgres | 52 tables, single source of truth |
| Row-Level Security | Enabled on every public table, each with explicit policies |
| PostgREST · GoTrue · Storage | Data access, identity, media |
| `service_role` server-side | Privileged access, never exposed to the browser |
| AES-256-GCM (`src/lib/crypto.ts`) | Encryption of provider, mailbox and integration credentials at rest |

**AI / LLM**

| Technology | Role |
|---|---|
| Provider-agnostic router | `agent` / `content` / `rag` / `light` capabilities, per-capability model assignment |
| 10 provider presets | Anthropic, OpenAI, Gemini, DeepSeek, Doubao, Kimi, Qwen, GLM, Grok, plus a custom OpenAI-compatible endpoint |
| Failover chain | Explicit degradation policy rather than a silent retry |
| Embeddings + pgvector | 1024-dimension retrieval for the knowledge base |
| Tool-use loop | Permission → audit → execution, with timeouts |

**Infrastructure**

| Technology | Role |
|---|---|
| Docker Compose | Two services: `web` (:5000, public) and `roveagent` (:8788, internal only) |
| Dockerfiles | Separate images per plane; no baked secrets |
| Caddy | TLS and on-demand certificates for merchant sites |
| Prometheus text endpoint | `/api/metrics` plus 13 alert rules with a machine validator |
| GitHub Actions | 3 CI jobs: TypeScript gate, Linux Python install + suite, both container builds |

---

## Project Structure

```
src/
  app/
    [locale]/            24 route groups — dashboard, agent, approvals, audit, knowledge,
                         reviews, customers, marketing, emails, business, reservations,
                         settings, team, staff, enterprise, files, store, site, website,
                         onboarding, admin, auth, unsubscribe, (marketing)
    api/                 132 route handlers
  components/            feature-grouped UI (agent, customer, delivery, layout, owner,
                         settings, staff, site, pwa, workspace, ui)
  lib/
    agent/               approvals, missions, registry, audit, personas
    enterprise/          agent roles, tool runtime, memory layers
    ai/  security/  payments/  email/  notifications/  observability/  connectors/
    tenant-db.ts         scoped data-access helpers
    mutation-guard.ts    central authenticate → scope → permission → intent → execute gate
  proxy.ts               network boundary: session check, header sanitisation, request id
roveagent/               RoveAgent Core — Python execution plane
  api/                   FastAPI app, capability registry/providers/router, plugin security
  tools/  skills/  plugins/  workforce/  tenant/  connectors/  gateway/
packages/roveagent-core/ TypeScript agent-loop primitives + third-party attribution manifest
scripts/                 migrations, validation gates, operational tooling
tests/                   118 TypeScript test files
docs/                    architecture, operations, engineering audit reports, assets
ops/alerts/              Prometheus alert rules
docker/                  deploy env templates, Caddy, database helpers
messages/                English, Chinese and Spanish product messages
```

---

## Development

### Prerequisites

| Tool | Version |
|---|---|
| Node.js | 22 |
| pnpm | 9 or newer (npm and yarn are rejected by a `preinstall` guard) |
| Python | 3.11 – 3.13 |
| Docker | Optional, for the container path |

### Installation

```bash
git clone https://github.com/houjinlong258-oss/roveframe.git
cd roveframe

pnpm install --frozen-lockfile           # web tier
pip install -e "./roveagent[web]"        # execution plane, with the FastAPI extras
```

### Environment Setup

Every credential is supplied at runtime; nothing is baked into an image and nothing is
committed. Never commit local environment files or credential values.

```bash
cp .env.example .env                             # web tier
cp docker/deploy.env.example docker/deploy.env   # container path
```

The variables that matter most:

| Variable | Purpose |
|---|---|
| `COZE_SUPABASE_URL` / `_ANON_KEY` / `_SERVICE_ROLE_KEY` | Project endpoint and keys. The service-role key is **server-side only**. |
| `COZE_SUPABASE_JWT_SECRET` | Enables local JWT verification, removing a round trip from every request. |
| `ENCRYPTION_SECRET` | AES-256-GCM key for credentials stored in the database (32+ characters). Rotation is supported via `ENCRYPTION_SECRET_PREVIOUS`. |
| `ROVEAGENT_API_KEY` / `ROVEAGENT_APPROVAL_SECRET` | Service-to-service authentication. The runtime **refuses to start** if these two are equal — otherwise holding the caller key would also mean being allowed to sign approval callbacks. |
| `ROVEAGENT_LLM_API_KEY` | Provider key for the agent runtime. |

### Run Locally

```bash
pnpm dev                # development server (port from .preview, default 5000)

python scripts/run-python-tests.py     # execution-plane suite (offline, no provider spend)
pnpm validate                          # the full gate
```

`pnpm validate` runs the migration contract, TypeScript, lint (code and styles), the complete
test suite and the production scan. A change is not finished until it exits 0.

Focused gates are also available individually:

```bash
pnpm scan:secrets   # credential scan — reports locations only, never values
pnpm scan:brand     # placeholder-brand leakage
pnpm scan:globals   # accidental globals
pnpm scan:artifacts # stray build artifacts
pnpm build          # production build (Next.js + custom server bundle)
```

Container path:

```bash
docker compose --env-file docker/deploy.env up -d --build
curl -fsS http://localhost:5000/api/health
```

### Database

Database changes are additive, and live in `scripts/migrate.sql` plus focused migration files
under `scripts/`. Review the target project before applying anything:

```bash
npx tsx scripts/run-migrate.ts
```

Do not apply migrations to an unidentified or unverified database target.

### Source delivery

Source archives are generated from an explicit allowlist and written outside the repository.
The packager runs the production scan before writing:

```bash
pnpm package:source -- --output ../roveframe-ai-business-os-source.zip
```

---

## Deployment

**Two supported paths. Pick one; do not mix them.** The distinction is where the database lives.

| | Path A — built-in database | Path B — external Supabase |
|---|---|---|
| Command | `bash install.sh` | `docker compose --env-file docker/deploy.env up -d --build` |
| Database | Postgres 17 in a container, plus PostgREST, GoTrue and Storage | your own Supabase project |
| Credentials | generated for you into `docker/deploy.env` (mode 600) | you fill in every value marked REQUIRED |
| Best for | a bare server, self-hosting, no signups | an existing Supabase project, managed backups |
| Compose files | `docker-compose.yml` + `docker-compose.selfhosted.yml` | `docker-compose.yml` |

### Path A — one command on a bare server

```bash
git clone https://github.com/houjinlong258-oss/roveframe.git
cd roveframe
bash install.sh --domain app.example.com --email ops@example.com --llm-key sk-...
```

`install.sh` brings up the whole platform behind Caddy with automatic HTTPS:

| Container | Role |
|---|---|
| `db` | `supabase/postgres:17.6.1.136` — the database, on a named volume |
| `rest` | PostgREST `v14.17` — the data API the app talks to |
| `auth` | GoTrue `v2.196.0` — identity (runs with autoconfirm, so no mail relay is required) |
| `storage` | Storage API `v1.74.0` — product images and videos |
| `gateway` | nginx `1.27-alpine` — exposes **only** `/storage/v1/object/public/*`; PostgREST and GoTrue are not reachable from the internet |
| `edge` | Caddy `2-alpine` — TLS, on-demand certificates for merchant custom domains |
| `web` | the Next.js control plane (bound to `127.0.0.1:5000`; everything public goes through `edge`) |

Useful flags: `--registry docker.m.daocloud.io/` when Docker Hub is blocked, `--admin-email` /
`--admin-password` / `--business "My Shop"` to create the first owner account, `--yes` for
unattended installs.

It is **idempotent** — re-running keeps the existing `docker/deploy.env`, so it will not rotate
the JWT secret out from under logged-in users or change the database password after the volume
is initialised — and it **fails loudly**: every wait has a deadline and prints the container logs
on timeout.

It deliberately does **not** touch DNS (point an A/AAAA record at the server first, or install
without `--domain` and use `http://<server-ip>`), and it does not configure a mail relay.

### Path B — external Supabase

```bash
cp docker/deploy.env.example docker/deploy.env
# fill in every value marked REQUIRED, then:
docker compose --env-file docker/deploy.env up -d --build
```

### What production requires

Three of these make the app **refuse to start** rather than run half-configured:

| Variable | Notes |
|---|---|
| `COZE_SUPABASE_URL` / `_ANON_KEY` | Project endpoint and public key |
| `COZE_SUPABASE_SERVICE_ROLE_KEY` | **Required in production** — the web service refuses to start without it. Server-side only, never shipped to a browser |
| `COZE_SUPABASE_JWT_SECRET` | Recommended: verifies sessions locally instead of a round trip per request |
| `ENCRYPTION_SECRET` | **Required in production.** AES-256-GCM key for stored credentials, 32+ chars. Must **differ** from the service-role key — reusing it means rotating the database credential makes every stored secret permanently undecryptable. Rotate via `ENCRYPTION_SECRET_PREVIOUS` (decryption-only) |
| `ROVEAGENT_API_KEY` / `ROVEAGENT_APPROVAL_SECRET` | Service-to-service auth. They must be **different values**: the runtime answers 503 when they match, so that holding the caller key does not also confer approval-signing authority |
| `ROVEAGENT_LLM_API_KEY` | The agent runtime answers 503 without it rather than fabricating an answer |
| `NEXT_PUBLIC_APP_URL` | Public origin — read at runtime, not baked into the image |
| `SITE_DOMAIN` | Empty means an IP-only install |
| Platform model (`ROVEFRAME_PLATFORM_LLM_*`) | Optional but worth setting on self-hosted installs: without a platform model, a **newly registered** tenant whose `model_assign` is `auto` has no working model, because signup creates tenant, business, user and profile but no `settings` row |

### Health, readiness and metrics

The image ships its own readiness probe, so an orchestrator needs no extra wiring:

```
HEALTHCHECK --interval=30s --timeout=20s --start-period=90s --retries=3
  → fetch http://127.0.0.1:5000/api/health     (non-2xx ⇒ unhealthy)
```

`/api/health` returns **503** unless all three hold — the live schema matches the expected
52 tables / 600+ columns, the agent runtime answers, and the scheduler's heartbeat is fresh. That
means "container up, database drifted" is exactly the state that stops receiving traffic.

```bash
curl -fsS http://localhost:5000/api/health            # 200 when ready, 503 with reasons when not
curl -fsS -H "X-RoveAgent-Key: $ROVEAGENT_API_KEY" \
     http://localhost:5000/api/metrics                # Prometheus text format
```

`ops/alerts/roveframe.rules.yml` holds 13 ready-to-load alert rules (availability, scheduler,
queue backlog, payments, memory) with a zero-dependency validator:

```bash
node scripts/check-alert-rules.mjs --base http://localhost:5000 --key "$ROVEAGENT_API_KEY"
```

### Schema creation and migration on first boot

`autoMigrate()` applies all **20** migration files (idempotent: `create … if not exists`,
`add column if not exists`, `drop policy if exists` + `create policy`) and then the preflight
verifies the result. It runs from the production entry point only — `next start` does **not**
load `src/server.ts`, so it will not migrate anything.

Migration needs **one** of `DATABASE_URL` / `POSTGRES_URL` / `DIRECT_URL` /
`COZE_SUPABASE_DATABASE_URL` / `SUPABASE_DATABASE_URL` / `PG_CONNECTION_STRING`, or
`SUPABASE_ACCESS_TOKEN`. Without them the process still starts and logs it plainly:

```
⚠️ [migrate] 未配置 DATABASE_URL 或 SUPABASE_ACCESS_TOKEN，跳过自动建表。
✓ [boot-check] 数据库 schema 完整
```

That is the safe failure mode: refuse to guess, say what is missing, and let `/api/health`
report the consequence.

### Custom domains (merchant storefronts)

A merchant binds their own domain in the app; Caddy issues the certificate on demand, asking the
application first so the server can never be used to mint certificates for arbitrary hostnames:

```caddyfile
on_demand_tls { ask http://web:5000/api/site/authorize }
```

That endpoint answers **200** only when the host matches `SITE_DOMAIN`, or a `public_sites` row
whose `custom_domain` is active *and* enabled; anything else is 404, fail-closed. A wiring test
asserts that this `ask` path really has a route and is on the public allowlist, because a typo
here fails silently: Caddy treats any non-2xx as denial, so every merchant domain would simply
never obtain a certificate.

### Scaling constraint: run one replica

Rate limiting and chat concurrency slots live in process memory, so the current build is
**single-replica by definition**. Setting `ROVEFRAME_RATE_LIMIT_SHARED=1` is a *declaration* that
a shared backend exists, not a switch — the startup contract check fails loudly if it is set and
the backend is not. Likewise, run exactly one process that owns the scheduler; a second one would
double the ticks.

### Post-deploy checklist

1. `curl -fsS http://<host>/api/health` → 200 (503 means schema drift or an unreachable runtime;
   the response says which).
2. Log in with the owner account created by `install.sh --admin-email`, or create/reset one with
   `npx tsx scripts/ensure-initial-user.ts` (idempotent; resets the password if the account
   exists).
3. `curl -H "X-RoveAgent-Key: …" /api/metrics` → counters present, and
   `roveframe_metrics_collection_ok` is 1 for every collector.
4. Scrape `/api/metrics` and load `ops/alerts/roveframe.rules.yml` — without this, a stalled
   scheduler or a growing queue is invisible.
5. Rotate any credential that was generated or shared during setup, then re-check health.

---

## Engineering Practices

This is the part of the project most worth reading the code for. The repository treats
**verification as a first-class feature**, and several guards exist specifically because an
earlier version of this project shipped a defect no test could see.

| Practice | What it means here |
|---|---|
| Fail closed by default | If the audit store is unreachable the mutation fails. If a schema check cannot read the database it reports *failed*, not *healthy*. |
| Guards must be able to fail | Every guard is validated by reverting the fix and confirming the guard turns red. A check whose failure cannot be produced is reported as proving nothing. |
| Live-database invariants | Row-level security coverage is asserted against the real database — both "every table has RLS" and "no table has RLS with zero policies" — not against migration text. |
| Schema drift detection | The boot preflight derives its expectation from the schema definition and compares it against the live database (52 tables / 600+ columns) instead of maintaining a hand-written subset. |
| Alert rules that reference real metrics | A zero-dependency validator rejects any rule naming a metric the codebase does not export, and cross-checks against the live metrics endpoint. |
| Money paths tested behaviourally | Currency exponents (zero-, two- and three-decimal currencies), signature verification with an explicit positive control, and idempotency are asserted by executing the code. |
| Honest documentation | Audit reports state what is *not* finished. Where a test needs credentials that are not present, it is reported as `UNVERIFIED` rather than passing silently. |

Gate status on the current checkout: **1,461 TypeScript tests** (0 failures), **815 Python
tests** (0 failures), and the production scan is clean across the whole tree (2,500+ files).

---

## Project Status

**Pre-launch.** This is a working system, built and operated end to end — not a prototype. It is
also honest about its edges:

- **Implemented and exercised against a real database**: multi-tenancy, RBAC, approval and audit
  flows, the agent runtime, the scheduler, delivery and workforce flows, email and push.
- **Deliberately manual for now**: merchant billing. Subscriptions are provisioned by an operator
  with offline payment records. Automated recurring billing is a product decision that has not
  been taken.
- **Not yet verified in this environment**: real-device iOS/Safari behaviour, live payment-provider
  round trips (no merchant credentials), and the social publishing capability (implemented and
  tested, not yet wired into the tool registry).

No user numbers, revenue figures or customer names appear in this project, because there are
none to report.

---

## Future Roadmap

Potential directions, in rough priority order. Nothing here is claimed as already built.

- **More agent capabilities** — broaden the tool registry, and connect the implemented-but-unwired
  social publishing surface.
- **Better workflow automation** — move remaining request-time work into the durable task queue;
  richer scheduling primitives.
- **More integrations** — complete the ERP adapter beyond connectivity; add further POS and
  payment connectors behind the existing webhook contract.
- **Horizontal scale** — replace the in-process rate-limit and concurrency state with a shared
  backend. The deployment contract for this is already asserted at startup.
- **Operations** — log aggregation and tracing; the metrics and alerting side already exists.

---

## License

MIT — see [LICENSE](LICENSE).

`roveagent/` is derived from an upstream agent runtime released under the MIT licence
(Copyright © 2025 Nous Research). The original licence text and the complete attribution
manifest — which name the upstream project explicitly — are preserved in
[`roveagent/NOTICE`](roveagent/NOTICE), [`roveagent/LICENSE`](roveagent/LICENSE) and
[`packages/roveagent-core/THIRD_PARTY_NOTICES.md`](packages/roveagent-core/THIRD_PARTY_NOTICES.md).
Third-party licence and attribution text is kept **only** in those designated locations, which
the repository's branding scan exempts by design; that is why this README points at them instead
of restating the attribution inline.

The enterprise layer — tenancy, RBAC, approvals, audit, connectors and the product surface — is
original work in this repository.

<div align="center">
<sub>Built with agents. Kept in human hands.</sub>
</div>
