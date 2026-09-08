#!/bin/bash
# RoveAgent Service 启动脚本（开发环境）
# 用法:  bash scripts/roveagent-service.sh [--port 8788]
# 生产:  见 ROVEAGENT_INTEGRATION_COMPLETE.md §7（uvicorn + 反向代理 + 独立 .env）
set -Eeuo pipefail

cd "$(dirname "$0")/.."

PORT="${ROVEAGENT_PORT:-8788}"
HOST="${ROVEAGENT_HOST:-127.0.0.1}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --port=*) PORT="${1#*=}"; shift ;;
    --host) HOST="$2"; shift 2 ;;
    --host=*) HOST="${1#*=}"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# 从 .env 读取共享密钥（与 Next.js 保持一致），不在脚本里硬编码
if [[ -z "${ROVEAGENT_API_KEY:-}" && -f .env ]]; then
  ROVEAGENT_API_KEY="$(grep -E '^ROVEAGENT_API_KEY=' .env | head -1 | cut -d= -f2- | tr -d '\r' | tr -d '"')"
fi
export ROVEAGENT_API_KEY="${ROVEAGENT_API_KEY:?ROVEAGENT_API_KEY missing (set in .env or environment)}"
export ROVEAGENT_ROOT="${ROVEAGENT_ROOT:-$(pwd)/.roveagent}"

# LLM 配置可选：缺失时 /api/agent/chat 返回 503（不伪造回答），其余端点正常
export ROVEAGENT_LLM_BASE_URL="${ROVEAGENT_LLM_BASE_URL:-}"
export ROVEAGENT_LLM_API_KEY="${ROVEAGENT_LLM_API_KEY:-}"
export ROVEAGENT_LLM_MODEL="${ROVEAGENT_LLM_MODEL:-}"

PYBIN="${ROVEAGENT_PYTHON:-python}"
echo "[roveagent] starting on http://${HOST}:${PORT}  (root=${ROVEAGENT_ROOT})"
exec "$PYBIN" -m uvicorn roveagent.api.app:get_app --factory \
  --host "$HOST" --port "$PORT" ${ROVEAGENT_UVICORN_EXTRA:-}
