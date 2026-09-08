# RoveFrame AI Executive Operations Platform

RoveFrame is an **AI Executive Operations Platform** — not restaurant software, not a chatbot. The first-stage product is the **Restaurant AI Chief of Staff**: it helps a restaurant owner every day to *understand the business, spot risks, get recommendations, approve actions, and have them executed automatically*.

Core loop (real, no stubs):

```
Business Data → AI Insight → Recommendation → Approval → Real Action
  → Execution Result → Audit → Memory
```

Three core entries: **Morning Executive Brief** (email + web push, 08:00 local), **Ask Business Question** (CEO Insight / COO / CMO / CTO personas on one runtime), **Approve AI Actions** (frozen-argument approvals with visible execution status and audit trail).

- RoveFrame is the SaaS product and control plane; RoveAgent Core is the intelligence and execution plane.
- Supabase business tables are the only source of truth; every protected operation is scoped by verified `tenant_id` + `business_id`, enforced in the application layer AND in Supabase RLS (see `scripts/migrate-rls.sql`).
- Pilot-readiness status: [`docs/current/PILOT_READY_STATUS.md`](docs/current/PILOT_READY_STATUS.md); upgrade plan: `PRODUCTION_GAP_PLAN.md`.

## Architecture

The current architecture source of truth is [`docs/current/ARCHITECTURE.md`](docs/current/ARCHITECTURE.md).

- RoveFrame owns authentication, tenants, businesses, RBAC, business data, approvals, audit, billing, integrations, public storefront APIs, and the product UI.
- RoveAgent Core owns Agent runtime behavior, planning, tool calling, skills, memory, subagents, scheduled AI work, and execution orchestration.
- Supabase business tables are the only source of truth for orders, customers, products, inventory, payments, reviews, and business profile data.
- Every protected operation is scoped by verified `tenant_id` and `business_id`; model-supplied arguments cannot choose that scope.

## Requirements

- Node.js 22
- pnpm 9 or newer
- Python 3.11–3.13 for RoveAgent Core
- A Supabase project for production business data

Only pnpm is supported for JavaScript dependency management.

## Local setup

```bash
pnpm install
```

Copy `.env.example` to a local `.env` and replace every placeholder. Never commit local environment files or credential values.

```bash
pnpm dev
```

The development server uses the port configured by `.preview` (5000 by default).

## Database

Database changes are additive and live in `scripts/migrate.sql` and the focused migration files under `scripts/`. Review the target Supabase project and environment before applying a migration.

```bash
pnpm tsx scripts/run-migrate.ts
```

Do not apply migrations to an unidentified or unverified database target.

## Validation

```bash
pnpm validate
python -m compileall -q roveagent
pnpm test:python
pnpm build
```

Focused production gates are also available:

```bash
pnpm scan:secrets
pnpm scan:brand
pnpm scan:globals
pnpm scan:artifacts
```

The secret scan reports rule IDs and file locations only; it never prints matched credential values.

## Source delivery

Source archives are generated from an explicit allowlist and must be written outside the repository:

```bash
pnpm package:source -- --output ../roveframe-ai-business-os-source.zip
```

The packager runs the production scan before writing an archive. Local environment files, runtime state, caches, generated sites, reports, worktrees, build outputs, and existing archives are excluded.

## Repository layout

```text
src/                     RoveFrame Next.js application and APIs
roveagent/               RoveAgent Core Python runtime
packages/roveagent-core/ Bounded TypeScript Agent loop primitives
scripts/                 Build, migration, verification, and release helpers
tests/                   TypeScript and RoveAgent end-to-end tests
docs/current/            Current architecture documentation
docs/archive/            Superseded plans and historical reports
messages/                English, Chinese, and Spanish product messages
public/                  Static product assets
```

Third-party license and attribution text is retained only in the designated `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md`, and `LICENSES/` locations.
