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
# Phase 12 / P1-9 — provision a CJK font for PDF rendering.
#
# Slim Linux images ship no CJK font, and src/lib/artifacts/pdf-writer.ts then
# degrades: Chinese PDFs lose their text. `public/fonts/` is candidate ③ in its
# documented discovery order, so placing the font there fixes it with no code
# change.
#
# Deliberately BEST-EFFORT (`|| echo`), for three reasons:
#   * a missing font degrades exactly as it does today — it is not a NEW failure
#     mode, so it must not fail an otherwise good build;
#   * the font is fetched, not committed (17 MB does not belong in git history);
#   * `COPY public` in the runner stage picks the file up automatically.
#
# Operators who cannot reach the network at build time can mount a font and set
# RF_PDF_FONT — candidate ② in the discovery order, which outranks public/fonts.
# ---------------------------------------------------------------------------
RUN node scripts/setup-pdf-font.mjs \
 || echo "WARN: CJK font unavailable — Chinese PDFs will degrade (set RF_PDF_FONT to override)"

# ---------------------------------------------------------------------------
# Stage 3 — runtime
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runner

WORKDIR /app

# No apt layer on purpose. `curl` was the only system package wanted here, and
# it existed solely to back the HEALTHCHECK — node:22-slim has no curl, and the
# Debian archive was unreachable on the authoring network (`bookworm/main`
# failed while `bookworm-security` resolved). Node 22 has a global fetch, so the
# probe needs no extra package at all.

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
#
# Node 22 global fetch, so no curl and no apt layer are needed.
# Phase 14：timeout 从 5s 提到 20s。
# /api/health 会查 11+ 张表，而生产库是**跨公网的远程 Supabase**；5s 是照本地库
# 设的，实测在真实库上稳定超时（docker inspect 报 "Health check exceeded timeout
# (5s)"），使一个功能完全正常的容器被标记 unhealthy。
# 这是只有把容器连到真实远程库才会暴露的缺陷 —— 本地/占位凭据下永远看不到。
HEALTHCHECK --interval=30s --timeout=20s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Documented production command (scripts/start.sh ends in the same invocation).
CMD ["node", "dist/server.js"]
