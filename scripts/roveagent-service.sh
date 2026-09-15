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

# Python 解释器（先解析，后续 Mock Provider 与 uvicorn 都依赖）
PYBIN="${ROVEAGENT_PYTHON:-python}"

# ---------------------------------------------------------------------------
# 依赖预检（Step 1.5）
#
# 背景：concurrent-log-handler 在 pyproject.toml 里声明为 win32 依赖，
# 但缺装时模块导入失败发生在【第一个用户请求】上（agent_init.py:1079 →
# logsetup.py:65），表现为 /api/agent/chat 返回 HTTP 500，而不是启动失败。
# 这里把失败前移到启动阶段。
#
# 用 `python -c` 而不是 heredoc：本项目在 Windows 上也会被调用，
# heredoc 在非 POSIX shell 下不可用。
# ---------------------------------------------------------------------------
DEP_CHECK='import importlib, sys
missing = []
try:
    import fastapi, uvicorn  # noqa: F401
except ImportError as exc:
    missing.append(exc.name + " (install: pip install -e \".[web]\")")
if sys.platform == "win32":
    try:
        importlib.import_module("concurrent_log_handler")
    except ImportError:
        missing.append("concurrent-log-handler (install: pip install concurrent-log-handler==0.9.29)")
if missing:
    sys.stderr.write("[roveagent] FATAL: missing runtime dependencies:\n")
    for item in missing:
        sys.stderr.write("  - " + item + "\n")
    sys.exit(1)'
"$PYBIN" -c "$DEP_CHECK" || exit 1

# 从 .env 读取共享密钥（与 Next.js 保持一致），不在脚本里硬编码
if [[ -z "${ROVEAGENT_API_KEY:-}" && -f .env ]]; then
  ROVEAGENT_API_KEY="$(grep -E '^ROVEAGENT_API_KEY=' .env | head -1 | cut -d= -f2- | tr -d '\r' | tr -d '"')"
fi
# 审批签名密钥：优先独立密钥，缺失时回落 API_KEY
# （与 roveagent/api/app.py:253 的回落语义保持一致，避免两端行为分叉）
if [[ -z "${ROVEAGENT_APPROVAL_SECRET:-}" && -f .env ]]; then
  ROVEAGENT_APPROVAL_SECRET="$(grep -E '^ROVEAGENT_APPROVAL_SECRET=' .env | head -1 | cut -d= -f2- | tr -d '\r' | tr -d '"')"
fi
# 测试模式标记
if [[ -z "${ROVEAGENT_TEST_MODE:-}" && -f .env ]]; then
  ROVEAGENT_TEST_MODE="$(grep -E '^ROVEAGENT_TEST_MODE=' .env | head -1 | cut -d= -f2- | tr -d '\r' | tr -d '"')"
fi

export ROVEAGENT_API_KEY="${ROVEAGENT_API_KEY:?ROVEAGENT_API_KEY missing (set in .env or environment)}"
# 审批签名密钥必须独立，不再回落到 API_KEY。
# 回落会让「持有 X-RoveAgent-Key」等于「持有审批放行权」——
# auth 与 approver 塌缩成同一主体，职责分离失效（见 api/app.py 的 signed_auth）。
export ROVEAGENT_APPROVAL_SECRET="${ROVEAGENT_APPROVAL_SECRET:?ROVEAGENT_APPROVAL_SECRET missing (must be a distinct secret from ROVEAGENT_API_KEY)}"
export ROVEAGENT_ROOT="${ROVEAGENT_ROOT:-$(pwd)/.roveagent}"

# ---------------------------------------------------------------------------
# 单一数据根（Step 1.5 / 问题 C）
#
# 内核读 ROVEAGENT_ROOT（api/app.py:138：kernel / tasks / chat_sessions），
# 但 roveagent 其余绝大多数子系统（logs / skills / auth.json / memory /
# plugin-data / cache …）都通过 constants.get_roveagent_home() 读 ROVEAGENT_HOME。
# 两者不一致 = 数据被劈成两个根，审计尤其难找。
#
# 这里把 ROVEAGENT_HOME 显式对齐到同一个根，保证只有【一个】数据根。
# 若部署方显式提供了不同的 ROVEAGENT_HOME，则尊重它（不覆盖）。
# ---------------------------------------------------------------------------
if [[ -z "${ROVEAGENT_HOME:-}" ]]; then
  export ROVEAGENT_HOME="${ROVEAGENT_ROOT}"
  echo "[roveagent] data root pinned: ROVEAGENT_HOME=ROVEAGENT_ROOT=${ROVEAGENT_ROOT}"
elif [[ "${ROVEAGENT_HOME}" != "${ROVEAGENT_ROOT}" ]]; then
  echo "[roveagent] WARNING: ROVEAGENT_HOME (${ROVEAGENT_HOME}) != ROVEAGENT_ROOT (${ROVEAGENT_ROOT})"
  echo "[roveagent]          audit goes to ROVEAGENT_ROOT/audit; other state follows ROVEAGENT_HOME"
fi

# ---------------------------------------------------------------------------
# LLM 配置
#
# 三种情况，互不重叠：
#   1) 生产（ROVEAGENT_TEST_MODE != true）
#      → 必须显式提供 ROVEAGENT_LLM_API_KEY，否则 /api/agent/chat 返回 503。
#        脚本不代填、不伪造（保持 app.py:113-116 的原有契约）。
#   2) 测试（ROVEAGENT_TEST_MODE = true）
#      → 未提供真实 Key 时，把内核指向本机 Mock LLM Provider，
#        使 API 契约 / SSE 事件 / TS→Python 链路可在无生产密钥下验证。
#   3) 测试 + 已提供真实 Key
#      → 尊重真实 Key（用于 Step 5 的真实链路验证）。
# ---------------------------------------------------------------------------
export ROVEAGENT_LLM_BASE_URL="${ROVEAGENT_LLM_BASE_URL:-}"
export ROVEAGENT_LLM_API_KEY="${ROVEAGENT_LLM_API_KEY:-}"
export ROVEAGENT_LLM_MODEL="${ROVEAGENT_LLM_MODEL:-}"

MOCK_PORT="${ROVEAGENT_MOCK_PORT:-8799}"
MOCK_PID=""

if [[ "${ROVEAGENT_TEST_MODE:-false}" == "true" ]]; then
  if [[ -z "$ROVEAGENT_LLM_API_KEY" ]]; then
    echo "[roveagent] TEST MODE: no real LLM key -> starting Mock LLM Provider on 127.0.0.1:${MOCK_PORT}"
    ROVEAGENT_MOCK_PORT="$MOCK_PORT" "$PYBIN" -m scripts.mock_llm_provider &
    MOCK_PID=$!
    export ROVEAGENT_LLM_BASE_URL="http://127.0.0.1:${MOCK_PORT}/v1"
    export ROVEAGENT_LLM_API_KEY="mock-test-key"
    export ROVEAGENT_LLM_MODEL="${ROVEAGENT_LLM_MODEL:-mock-model}"
    # 内核退出时一并收掉 mock 进程
    trap '[[ -n "$MOCK_PID" ]] && kill "$MOCK_PID" 2>/dev/null || true' EXIT INT TERM
  else
    echo "[roveagent] TEST MODE: real LLM key present -> using configured provider"
  fi
else
  if [[ -z "$ROVEAGENT_LLM_API_KEY" ]]; then
    echo "[roveagent] WARNING: ROVEAGENT_LLM_API_KEY not set — /api/agent/chat will return 503 (by design, no fabricated replies)"
  fi
fi

PYBIN="${ROVEAGENT_PYTHON:-python}"
echo "[roveagent] starting on http://${HOST}:${PORT}  (root=${ROVEAGENT_ROOT})"
exec "$PYBIN" -m uvicorn roveagent.api.app:get_app --factory \
  --host "$HOST" --port "$PORT" ${ROVEAGENT_UVICORN_EXTRA:-}
