#!/bin/bash
set -Eeuo pipefail

COZE_WORKSPACE_PATH="${COZE_WORKSPACE_PATH:-$(pwd)}"

cd "${COZE_WORKSPACE_PATH}"

echo "Installing dependencies..."
pnpm install --prefer-frozen-lockfile --prefer-offline --loglevel debug --reporter=append-only

# ---------------------------------------------------------------------------
# PDF 中文字体供给。
#
# 字体是**供给(fetch)不是源码** —— 17MB 的 .ttf 被 .gitignore 刻意排除
# （`.gitignore` 的 "CJK fonts are PROVISIONED, not source" 与本目录
#  public/fonts/README.md 都写了原因）。所以**任何一次干净检出或云端构建都不会自带它**，
# 而 src/lib/artifacts/pdf-writer.ts 找不到字体时，会把中文 PDF 降级成 Word/网页。
#
# Dockerfile 早就做了这一步；这里补上，是因为 Coze 云端部署走的是
# `.coze` 的 [deploy] build = bash scripts/build.sh —— 不在这一步做，云端就永远没有字体
# （实测：线上实例报 "PDF 需要中文字体"，/api/health 之外一切正常）。
#
# 刻意 best-effort（与 Dockerfile 同一理由）：缺字体只是"少一个格式"，
# 不是新的失败模式，不该让一次本来合格的构建失败。但**必须把话说清楚**，
# 否则中文 PDF 会静默降级，用户只看到"生成 PDF 失败"，不知为什么。
# ---------------------------------------------------------------------------
echo "Provisioning the CJK font used by PDF rendering..."
if ! node scripts/setup-pdf-font.mjs; then
  echo "WARN: CJK font unavailable — Chinese PDF export will degrade to Word/HTML."
  echo "      Run 'node scripts/setup-pdf-font.mjs' with network access,"
  echo "      or set RF_PDF_FONT to a local .ttf path."
fi

echo "Building the Next.js project..."
# 抑制 Node 24 内部 module.register() deprecation(Next.js 16 Turbopack 内部调用)
# 不影响 build 行为,只让 exit code 不被 stderr 污染
NODE_OPTIONS="${NODE_OPTIONS:-} --no-deprecation" pnpm next build

echo "Bundling server with tsup..."
pnpm tsup src/server.ts --format cjs --platform node --target node20 --outDir dist --no-splitting --no-minify

echo "Build completed successfully!"
