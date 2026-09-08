# RoveAgent Core

Native TypeScript runtime extraction for RoveFrame. Entry: `src/index.ts`.

The core exposes a bounded agent loop, execution budget, canonical tool-call
keys and repeated-output detection. Provide `plan` and `execute` callbacks;
the executor must enforce your authenticated scope and enterprise policies.

The RoveFrame adapter is `src/lib/agent/gateway.ts` in the host application.
The core has no application, database, Python or external-service dependencies.
Its source exports require a TypeScript-aware consumer or a build step.

This is the initial core extraction, not the full AI Workforce product. See
the root migration and architecture reports for acceptance boundaries.
Source origin and license are preserved in `THIRD_PARTY_NOTICES.md`, `LICENSE`
and `provenance.json`.
