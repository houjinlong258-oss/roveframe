#!/bin/bash
set -Eeuo pipefail

COZE_WORKSPACE_PATH="${COZE_WORKSPACE_PATH:-$(pwd)}"

PORT=5000
DEPLOY_RUN_PORT="${DEPLOY_RUN_PORT:-$PORT}"


start_service() {
    cd "${COZE_WORKSPACE_PATH}"
    if [ -f scripts/deploy.env ]; then
        set -a; source scripts/deploy.env; set +a
        echo "[start.sh] deploy.env loaded -> $(echo "${COZE_SUPABASE_URL:-}" | sed -E 's#https?://([^/]+)/?.*#\1#')"
    else
        echo "[start.sh] WARNING: scripts/deploy.env NOT FOUND in $(pwd)"
    fi
    if [ -f .env ]; then set -a; source .env; set +a; fi
    export COZE_PROJECT_ENV=PROD
    echo "Starting HTTP service on port ${DEPLOY_RUN_PORT} for deploy..."
    PORT=${DEPLOY_RUN_PORT} node dist/server.js
}

echo "Starting HTTP service on port ${DEPLOY_RUN_PORT} for deploy..."
start_service
