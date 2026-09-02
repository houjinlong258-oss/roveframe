#!/bin/bash
set -Eeuo pipefail

COZE_WORKSPACE_PATH="${COZE_WORKSPACE_PATH:-$(pwd)}"

cd "${COZE_WORKSPACE_PATH}"

echo "Installing dependencies..."
pnpm install --prefer-frozen-lockfile --prefer-offline --loglevel debug --reporter=append-only

echo "Building the Next.js project..."
# 抑制 Node 24 内部 module.register() deprecation(Next.js 16 Turbopack 内部调用)
# 不影响 build 行为,只让 exit code 不被 stderr 污染
NODE_OPTIONS="${NODE_OPTIONS:-} --no-deprecation" pnpm next build

echo "Bundling server with tsup..."
pnpm tsup src/server.ts --format cjs --platform node --target node20 --outDir dist --no-splitting --no-minify

echo "Build completed successfully!"
