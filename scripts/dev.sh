#!/bin/bash
set -Eeuo pipefail


PORT=5000
COZE_WORKSPACE_PATH="${COZE_WORKSPACE_PATH:-$(pwd)}"
DEPLOY_RUN_PORT="${DEPLOY_RUN_PORT:-${PORT}}"

# 转发 CLI 参数：--port N / --host H（供预览工具指定端口）
DEV_HOST="${DEV_HOST:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      DEPLOY_RUN_PORT="$2"; shift 2 ;;
    --port=*)
      DEPLOY_RUN_PORT="${1#*=}"; shift ;;
    --host)
      DEV_HOST="$2"; shift 2 ;;
    --host=*)
      DEV_HOST="${1#*=}"; shift ;;
    *)
      shift ;;
  esac
done


cd "${COZE_WORKSPACE_PATH}"

# 项目 .env 优先于平台注入的同名变量（用户自有 Supabase 接入）
if [ -f .env ]; then set -a; source .env; set +a; fi
export COZE_PROJECT_ENV=DEV

kill_port_if_listening() {
    local pids
    pids=$(ss -H -lntp 2>/dev/null | awk -v port="${DEPLOY_RUN_PORT}" '$4 ~ ":"port"$"' | grep -o 'pid=[0-9]*' | cut -d= -f2 | paste -sd' ' - || true)
    if [[ -z "${pids}" ]]; then
      echo "Port ${DEPLOY_RUN_PORT} is free."
      return
    fi
    echo "Port ${DEPLOY_RUN_PORT} in use by PIDs: ${pids} (SIGKILL)"
    echo "${pids}" | xargs -I {} kill -9 {}
    sleep 1
    pids=$(ss -H -lntp 2>/dev/null | awk -v port="${DEPLOY_RUN_PORT}" '$4 ~ ":"port"$"' | grep -o 'pid=[0-9]*' | cut -d= -f2 | paste -sd' ' - || true)
    if [[ -n "${pids}" ]]; then
      echo "Warning: port ${DEPLOY_RUN_PORT} still busy after SIGKILL, PIDs: ${pids}"
    else
      echo "Port ${DEPLOY_RUN_PORT} cleared."
    fi
}

echo "Clearing port ${DEPLOY_RUN_PORT} before start."
kill_port_if_listening
echo "Starting HTTP service on port ${DEPLOY_RUN_PORT} for dev..."

PORT=${DEPLOY_RUN_PORT} HOSTNAME="${DEV_HOST:-localhost}" pnpm tsx watch src/server.ts
