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
#  * The runtime stage uses Next's `output: 'standalone'` tree instead of the
#    FULL node_modules.
#
#    History (kept deliberately): this file previously kept the FULL
#    node_modules + .next tree, with the recorded reason —
#
#      "next.config.ts does not enable standalone output and tsup externalises
#       npm dependencies, and this image could not be built or smoke-tested on
#       the authoring machine (the Docker daemon was unavailable). Shipping the
#       known-complete tree is the honest choice; `output: 'standalone'` is
#       recorded as a follow-up optimisation rather than an untested change."
#
#    That follow-up is now implemented. **The blocker did not go away**: the
#    Docker daemon is still unavailable on the authoring machine, so the new
#    layout is still not smoke-tested there. Instead of shipping an untested
#    hope, the change is made fail-closed — the runtime stage asserts, at build
#    time, that every external dependency of dist/server.js resolves inside the
#    traced node_modules, and fails the build if not. See that RUN below.
#
#    Two things standalone does NOT give you, both handled explicitly below:
#    `.next/static` is not part of the standalone tree, and the entry must stay
#    `node dist/server.js` — the standalone server.js would silently bypass
#    src/server.ts's scheduler / migration / boot-check / rate-limit assertions.
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

# standalone 产物：`next build` 用 nft（node file trace）追踪出的**最小**
# node_modules + `.next/server` + 一份 package.json。
#
# 为什么入口仍然是 `dist/server.js` 而不是 standalone 自带的 `server.js`：
# 后者是 Next 自动生成的最小服务器，它会**绕过** `src/server.ts` 里那几件生产
# 必须做的事 —— startScheduler / autoMigrate / runBootChecks / 进程守卫 /
# 限流契约断言。改用自带 server.js 等于静默降级，所以这里只借用它的
# node_modules 与 .next，入口保持 `node dist/server.js`（见文件末尾 CMD）。
COPY --from=builder /app/.next/standalone ./
# `.next/static` **不在** standalone 目录里（Next 只对 node_modules 与 server 产物
# 做追踪），必须单独拷；漏掉的表现是页面能出 HTML 但所有 CSS/JS 404。
COPY --from=builder /app/.next/static     ./.next/static
COPY --from=builder /app/public           ./public
COPY --from=builder /app/dist             ./dist
COPY --from=builder /app/messages         ./messages
COPY --from=builder /app/scripts          ./scripts

# ---------------------------------------------------------------------------
# 构建期 fail-closed：确认 dist/server.js 的每个外部依赖在裁剪后的
# node_modules 里都真的能解析。
#
# 为什么需要：standalone 的依赖集合是**追踪推断**出来的，不是声明出来的。
# 一旦 nft 漏掉一个包，产品不会在构建期报错，而是在**容器启动时**抛
# MODULE_NOT_FOUND —— 也就是只在生产暴露。这里把这条失败提前到构建期。
#
# 依赖清单不从别处抄，而是**当场从 dist/server.js 里解析**：
# 以后谁给 server.ts 加了新 import，这个检查自动覆盖，不需要同步维护列表。
# ---------------------------------------------------------------------------
RUN node -e "const fs=require('fs');const mod=require('module');const src=fs.readFileSync('dist/server.js','utf8');const specs=[...src.matchAll(/require\([\"']([^\"']+)[\"']\)/g)].map(m=>m[1]);const ext=[...new Set(specs)].filter(s=>!/^\./.test(s)&&!/^node:/.test(s)&&!mod.builtinModules.includes(s));const missing=ext.filter(s=>{try{require.resolve(s);return false}catch{return true}});console.log('dist/server.js 外部依赖 '+ext.length+' 个:',ext.join(', '));if(missing.length){console.error('MISSING in standalone node_modules: '+missing.join(', '));process.exit(1)}console.log('OK: 全部可解析')"

# Drop root. The image writes nothing to /app at run time; SQLite/state belongs
# to the RoveAgent container.
USER node

EXPOSE 5000

# /api/health is the app's own readiness probe: it verifies the database schema
# it depends on. A 503 here means "app up, database not migrated or drifted",
# which is exactly when this container should NOT be routed traffic.
#
# Node 22 global fetch, so no curl and no apt layer are needed.
#
# Phase 14：timeout 从 5s 提到 20s —— 当时 /api/health 逐张表串行探测（11+ 次远程
# 往返），5s 是照本地库设的，实测在真实远程库上稳定超时（docker inspect 报
# "Health check exceeded timeout (5s)"），使一个功能完全正常的容器被标记 unhealthy。
# 这是只有把容器连到真实远程库才会暴露的缺陷。
#
# Phase 19：探测换成"一次拉取 schema 文档 + 与 schema.ts 全量比对"
# （52 张表 / 600+ 列，见 src/lib/schema-drift.ts），往返从 11+ 次降到 1 次；
# 本机实测 p50 由 5145ms 降到 1062ms。20s 的余量因此更宽裕，保留不变 ——
# 它同时覆盖"远端库慢"与"DNS 慢"两种真实情况，收紧只会换来误报。
HEALTHCHECK --interval=30s --timeout=20s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Documented production command (scripts/start.sh ends in the same invocation).
CMD ["node", "dist/server.js"]
