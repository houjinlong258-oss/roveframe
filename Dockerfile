# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# RoveFrame AI Business OS — Web (Next.js 16 + custom server)
#
# Phase 11 / Task 2. Before this file existed there was NO container manifest of
# any kind in the repository, and the declared production chain
# (scripts/build.sh + scripts/start.sh) never started the Python RoveAgent
# runtime at all — which is why 821k lines of Python had never executed in a
# real deployment.
#
# Design notes (each one is deliberate, see Runtime_Deployment_Report.md):
#
#  * Three stages. `deps` installs the pnpm store once and is reused by
#    `builder`, so a source-only change does not re-resolve the lockfile.
#
#  * The runtime stage keeps the FULL node_modules and .next tree instead of
#    using Next's `output: 'standalone'`. next.config.ts does not enable
#    standalone output and tsup externalises npm dependencies, and this image
#    could not be built or smoke-tested on the authoring machine (the Docker
#    daemon was unavailable). Shipping the known-complete tree is the honest
#    choice; `output: 'standalone'` is recorded as a follow-up optimisation
#    rather than an untested change.
#
#  * scripts/ IS copied: src/lib/migration.ts reads scripts/*.sql at boot, and
#    if those files are missing it throws inside an un-awaited IIFE with no
#    unhandledRejection handler — the process would crash-loop. Only the .sql
#    and .mjs files are needed; .dockerignore already excludes
#    scripts/deploy.env so no credentials enter the build context.
#
#  * NPM_REGISTRY is a build arg because .npmrc pins registry.npmmirror.com
#    (a China mirror). Builds outside that network must be able to override it
#    without editing a tracked file.
#
#  * Build args are NOT secrets. Every credential is injected at run time by
#    docker-compose and never appears in a layer.
# ---------------------------------------------------------------------------

ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
# Stage 1 — dependency resolution
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps

ARG NPM_REGISTRY=https://registry.npmmirror.com

WORKDIR /app

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true

# corepack reads the exact version from package.json#packageManager (pnpm@9.0.0)
RUN corepack enable

# .npmrc is copied first so the registry override applies to the install.
# scripts/ensure-pnpm.mjs is the package.json `preinstall` gate: it hard-fails
# unless the npm user agent starts with "pnpm/", so it must exist before install.
COPY package.json pnpm-lock.yaml .npmrc ./
COPY scripts/ensure-pnpm.mjs scripts/ensure-pnpm.mjs

RUN if [ "$NPM_REGISTRY" != "https://registry.npmmirror.com" ]; then \
      pnpm config set registry "$NPM_REGISTRY"; \
    fi \
 && pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# Stage 2 — production build
# ---------------------------------------------------------------------------
FROM deps AS builder

WORKDIR /app

COPY . .

# Mirrors scripts/build.sh exactly, minus `pnpm install` (already done in deps).
# NODE_OPTIONS suppresses the Node 24 module.register() deprecation emitted by
# Next.js 16 internals; it must not pollute the exit code.
RUN NODE_OPTIONS="${NODE_OPTIONS:-} --no-deprecation" pnpm next build \
 && pnpm tsup src/server.ts --format cjs --platform node --target node20 \
      --outDir dist --no-splitting --no-minify

# ---------------------------------------------------------------------------
# Stage 3 — runtime
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runner

WORKDIR /app

# curl backs the HEALTHCHECK below; it is the only added system package.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    COZE_PROJECT_ENV=PROD \
    PORT=5000

COPY --from=builder /app/node_modules      ./node_modules
COPY --from=builder /app/.next             ./.next
COPY --from=builder /app/dist              ./dist
COPY --from=builder /app/public            ./public
COPY --from=builder /app/messages          ./messages
COPY --from=builder /app/scripts           ./scripts
COPY --from=builder /app/package.json      ./package.json
COPY --from=builder /app/next.config.ts    ./next.config.ts
COPY --from=builder /app/tsconfig.json     ./tsconfig.json
COPY --from=builder /app/postcss.config.mjs ./postcss.config.mjs

# Drop root. The image writes nothing to /app at run time; SQLite/state belongs
# to the RoveAgent container.
USER node

EXPOSE 5000

# /api/health is the app's own readiness probe: it verifies the database tables
# it depends on. A 503 here means "app up, database not migrated", which is
# exactly when this container should NOT be routed traffic.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

# Documented production command (scripts/start.sh ends in the same invocation).
CMD ["node", "dist/server.js"]
