# Runtime Deployment Report

Phase 11 / Task 2. 范围：为 RoveFrame 建立最小生产运行链（frontend + Python runtime + database 配置），
并实测 health / chat API / agent 调用。所有结论基于本次实测命令输出；无法验证者显式标注 UNVERIFIED。

---

## 1. 起点：审计结论原文

> 执行面 100% 不可达 —— 但它能跑。
> `.coze` 仅 `requires=["nodejs-24"]`、`scripts/start.sh` 只跑 `node dist/server.js`、
> `scripts/deploy.env` 无 `ROVEAGENT_*`。结论：821,458 行代码从未在真实部署中运行过一次。

本次实测复现并确认：

| 检查 | 结果 |
|---|---|
| `Dockerfile` / `docker-compose*` / 任何容器清单 | **0 个文件** |
| `scripts/build.sh`、`start.sh`、`dev.sh`、`prepare.sh` 中出现 `python`/`uvevorn`/`8788` | **0 次** |
| Python 运行时依赖（`fastapi` 等）由谁安装 | **无人安装**——`pyproject.toml` 里是 optional extra |
| `dist/server.js`（生产 bundle） | 不存在 |
| `.next/BUILD_ID`（生产构建产物） | 不存在 |

---

## 2. 交付物

| 文件 | 作用 |
|---|---|
| `Dockerfile` | Web 控制面。三阶段（deps → builder → runner），非 root，带 HEALTHCHECK |
| `Dockerfile.roveagent` | Python 执行面。`python:3.13-slim` + editable 安装 + `/data` 卷 + 非 root |
| `docker-compose.yml` | 两服务编排，共享状态卷，全部凭据运行期注入 |
| `docker/deploy.env.example` | 部署环境变量模板（占位符，无真实值） |
| `.dockerignore` | 补 `scripts/deploy.env`（见 §5） |

### 关键设计决策

**为什么保留完整的 `node_modules` + `.next`，而不用 `output: 'standalone'`**
`next.config.ts` 未启用 standalone，`tsup` 默认外置 npm 依赖。本机 Docker daemon 不可用，
改构建配置无法被验证。在这种前提下，交付"已知完整"的产物树比交付一个未经验证的优化更诚实。
`output: 'standalone'` 列为后续优化项，不在此次改动中。

**为什么 `scripts/` 必须进镜像**
`src/lib/migration.ts` 在启动时读取 `scripts/*.sql`；文件缺失时它在一个**未被 await 的 IIFE** 里抛错
（`src/server.ts` 的 `void (async () => …)()`），而 `src/` 全局没有 `uncaughtException` /
`unhandledRejection` 处理器 —— 进程直接退出，形成 crash-loop。

**为什么 Python 用 editable 安装（`pip install -e`）**
`roveagent/pyproject.toml` 的 `[tool.setuptools.packages.find] where = [".."]` 要求安装目录的父目录
包含 `roveagent/`；更重要的是 `[tool.setuptools.package-data]` 只覆盖 `.md/.json/.yaml`，
而 `skills_library/**` 下还有 `.mjs/.js/.html/.sh` 模板。非 editable 安装会**静默产出缺模板的 wheel**。

**为什么复用 `scripts/roveagent-service.sh` 作为 entrypoint**
它已经实现了四件事，重新实现会形成第二份会漂移的副本：
失败即停的密钥校验、拒绝 approval secret 等于 API key、统一 `ROVEAGENT_HOME`/`ROVEAGENT_ROOT`、
以及测试模式下拉起 Mock LLM。

---

## 3. 验证结果

### 3.1 已完成验证（本机原生运行，非容器）

本机 Docker daemon 不可用（见 §4），因此改为**直接运行真实进程**验证运行链。
对"执行面是否真的能跑"这个问题，进程级证据比镜像构建证据更直接。

| ID | 验证项 | 命令 / 方式 | 结果 |
|---|---|---|---|
| V-1 | Python 运行时启动 | `uvicorn roveagent.api.app:get_app --factory` | 启动成功 |
| V-2 | **health** | `GET /api/health` | **HTTP 200** `{"status":"ok","service":"roveagent","tenants":0}` |
| V-3 | auth 失败即拒绝 | `POST /api/agent/chat` 无 `X-RoveAgent-Key` | **HTTP 401**（符合预期） |
| V-4 | **chat API** | `POST /api/agent/chat` 带 key | **HTTP 200**，7501 ms（冷启动） |
| V-5 | 热态延迟 | 同上连续 3 次 | **2310 / 1708 / 1668 ms** |
| V-6 | **agent 工具调用 + Gate** | 发含 "read" 的请求触发工具调用 | **HTTP 200**；`tool_gate.jsonl` 新增条目 |
| V-7 | skills 市场 | `GET /api/agent/skills/market` | **HTTP 200**，`count=73` |
| V-8 | capability 健康 | `GET /api/capabilities/health` | **HTTP 200**，`ready=true`，73 capabilities |
| V-9 | **TS → Python 链路** | 真实模块 `src/lib/roveagent/client.ts`（非手写 fetch） | **link OK**，见下表 |
| V-10 | 生产构建无凭据 | `pnpm build`，隐藏 `scripts/deploy.env` + 占位凭据 | **exit 0**，产出 `dist/server.js` 146.67 KB |
| V-11 | compose 语法与变量插值 | `docker compose config --quiet` | **exit 0**，services = `[roveagent, web]` |
| V-12 | compose 缺变量即失败 | 取消 `ENCRYPTION_SECRET` | **exit 1**，报错并点名缺失变量 |

V-9 明细（驱动真实生产客户端模块）：

```
ROVEAGENT_API_URL = http://127.0.0.1:8788
  PASS  roveAgentConfigured()     true
  PASS  roveAgentHealth()         {"ok":true,"status":"ok","latencyMs":33,"detail":"runtime reachable"}
  PASS  roveAgentChat()           reply 52 chars, agent=ceo
  PASS  roveAgentChat() tool turn reply 64 chars
RESULT: link OK   exit=0
```

### 3.2 V-6 的意义：Gate 是真的在工作

Mock provider 的回复文案里写着"所有工具调用均经 EnterpriseToolGate 判定"。
**这是脚本台词，不是证据**，因此做了独立核对。

核对方式与结果：

1. `~/.roveagent/audit/tool_gate.jsonl`（79 条）最后写入时间为 **2026-09-13**，近 10 分钟新增 **0** 条
   —— 说明早期几次不含工具调用的请求**确实没有**任何 gate 记录，符合预期。
2. 改为发送含 "read" 的请求触发真实工具调用后，配置的 `ROVEAGENT_ROOT/audit/tool_gate.jsonl`
   出现新条目，累计 **21 条**：

| tool | risk | required_permissions | allowed | reason |
|---|---|---|---|---|
| `read_sales` | LOW | `orders:read` | **false** | permission denied: requires 'orders:read' |

即：agent loop 真的发起了工具调用、每次调用真的过了 Gate、Gate 真的按权限**拒绝**了
（验证身份只带 `business:read`）。default-deny 与权限判定在生产配置下是活的。

### 3.3 容器内验证（Docker daemon 可用后补做）

原 §3.3 的 U-1/U-2/U-3 已全部转为**已验证**。

| ID | 验证项 | 结果 |
|---|---|---|
| V-B1 | `docker build` 运行时镜像 | **exit 0**，`roveframe/roveagent-runtime:phase11`，567 MB |
| V-B2 | `docker build` Web 镜像 | **exit 0**，`roveframe/web:phase11`，**1.57 GB** |
| V-B3 | 容器内 `pip install -e "./roveagent[web]"`（U-3） | **成功**。全部依赖解析为 manylinux wheel，**无需编译器**；安装到 **pin 的确切版本**（fastapi 0.133.1 / starlette 1.3.1 / uvicorn 0.41.0） |
| V-B4 | `scripts/deploy.env` 是否进入镜像层 | **不存在**（`.dockerignore` 生效）；镜像内 `*.env` 命中 0 |
| V-B5 | `scripts/*.sql` 是否在镜像内 | 存在，**11 个**（启动期 DDL 依赖满足） |
| V-B6 | 非 root 运行 | web `uid=1000(node)`；runtime `uid=10001(rove)` |
| V-B7 | `docker compose up` | 栈启动成功；`roveagent` **healthy** 后 `web` 才启动（`depends_on: service_healthy` 生效） |
| V-B8 | 容器内 `GET /api/health` | **HTTP 200** |
| V-B9 | 容器内 `POST /api/agent/chat` | **HTTP 200**，agent 循环运行（日志 `tool_turns=2, api_calls=3`） |
| V-B10 | 运行时端口是否对外暴露 | host 侧 `127.0.0.1:8788` **不可达**（compose 仅 `expose`，未 publish）——符合设计 |
| V-B11 | Gate 是否装载 | `tool_execution` 中间件链含 `enterprise_gate_middleware`，`fail_closed=True`，**100 条策略** |
| V-B12 | Gate 直连判定 + 审计落地（容器内） | `gate.authorize()` 写入审计成功，`audit_root()=/data/audit` |

镜像构建阶段发现并修复的两个真实缺陷：

| 缺陷 | 现象 | 修复 |
|---|---|---|
| **B-01** `/data` 属主 UID 与运行用户 UID 不一致 | 容器启动后 healthcheck 失败：`PermissionError: [Errno 13] Permission denied: '/data/tenants'`（`TenantManager` 在首次请求时创建该目录）。根因：`chown -R 1000:1000 /data` 与 `useradd --uid 10001` 两个数字不一致 | 改用单一 `ARG UID_RUNTIME` 同时驱动 `useradd`、`chown /data`、`chown /app`、`USER`，两个数字不可能再漂移 |
| **B-02** HEALTHCHECK 依赖 `curl`，而基础镜像无 `curl` | 为装 `curl` 引入 apt 层，构建时 `deb.debian.org` 的 `bookworm/main` 索引不可达（`bookworm-security`/`bookworm-updates` 正常），构建直接失败 | 去掉 apt 层。web 用 Node 22 内置 `fetch`，runtime 用 Python stdlib `urllib` 做探针。镜像更小、依赖更少 |

B-01 只在**真正运行容器**时才会暴露 —— 静态审阅 Dockerfile 看不出问题。这正是把镜像构建标为 UNVERIFIED 而不是"He 该没问题"的价值。

### 3.4 未解决：容器内 agent 工具调用未经过 Gate（F-C1）

这是本次容器验证中发现的一个**未解释的行为差异**，如实记录。

在**同一台机器、同一条消息、同一组权限**下做对照：

| | 原生进程 | 容器 |
|---|---|---|
| 消息 | `please read the README file` | 同左 |
| `ROVEAGENT_GATE_TRACE` | `1` | `1` |
| Mock 返回的工具 | `read_file` → 被改写为 `read_sales` | `read_file`（未改写） |
| stderr `[gate-trace]` 行数 | **7** | **0** |
| `tool_gate.jsonl` 新增条目 | **7**（`read_sales`，全部 `allowed=false`，`reason=permission denied: requires 'orders:read'`） | **0** |
| 请求耗时 | 8164 ms | 104035 ms |

已定位的机制：`roveagent/core/conversation_loop.py:7271-7276` 只在
`tool_name not in agent.valid_tool_names` 时才做名称修复。
原生环境里 `read_file` 不在 ceo agent 的 `valid_tool_names` 中 → 改写成 `read_sales` → 进入 Gate；
容器里 `read_file` 未被改写 → 该次调用**没有产生任何 `[gate-trace]` 输出**。

**已知：** 容器内 Gate 中间件确实已装载（V-B11）、确实可用（V-B12）、
且 agent 循环确实运行了工具轮次（V-B9）。**未知：** 为什么这些工具轮次没有经过 `tool_execution` 中间件链。
根因**未确定**，需要一轮定向排查。

两项环境差异值得优先排查：容器内 `read_file` 是否真的在 `valid_tool_names` 中（若在，则工具集解析在两种环境下不同）；
以及容器内是否存在绕过中间件链的派发路径（日志显示容器内发生了
`Lazy-installing edge-tts==7.2.7` 这类**请求期惰性安装**，104 秒的延迟与之吻合，需确认它是否同时改变了工具派发路径）。

在根因确定之前，**不应假定容器部署下 Gate 对 agent 发起的工具调用生效**。

### 3.5 未验证项（UNVERIFIED，剩余）

| ID | 项 | 原因 |
|---|---|---|
| U-5 | F-C1 根因 | 见 §3.4。排查过程中 Docker Desktop 引擎无响应（API 500），重启后未能在本次恢复 |
| U-6 | 真实 Supabase 下的端到端（web 容器 /api/health 200） | 有意未做：容器内用的是占位凭据，指向真实库会让 web 的 scheduler 对生产数据产生副作用 |

容器内 `web` 服务的 `/api/health` 因占位数据库不可达而返回 503 —— 这是**正确**结果，
而非缺陷：该端点本就是数据库就绪探针。

---

## 4. Docker daemon 的处理过程

首次撰写时 daemon 不可用：

```
docker version → failed to connect to the docker API at
                 npipe:////./pipe/dockerDesktopLinuxEngine
```

当时的处置：**不伪造验证**，改为用真实进程验证运行链（§3.1，证据强度更高），
把镜像构建明确标为 UNVERIFIED，并写进 CI 使 U-1/U-3 必然被验证。

daemon 可用后（用户启动 Docker Desktop），补做了全部容器验证（§3.3）。
实际结果证明这个流程是对的：镜像构建**首次尝试即失败**（apt 层，见 B-02），
容器运行**首次尝试即失败**（UID 不匹配，见 B-01）。
两处都不是"读代码能看出来"的问题。若当时用"看起来没问题"结案，这两个缺陷会带进生产。

---

## 5. 部署安全：凭据不得进入镜像层

原 `.dockerignore` 只忽略 `.env` / `.env.*`，**漏掉 `scripts/deploy.env`**。
而 `src/storage/database/supabase-client.ts:25` 用
`dotenv.config({ override: true, path })` 加载它。

两个后果叠加：

1. 凭据被 COPY 进镜像层，永久留在 `docker history` 里；
2. 由于 `override: true`，镜像里的副本会**静默覆盖**容器注入的环境变量 ——
   运维以为改了 env 就完成轮换，实际仍在用旧密钥。

已修正 `.dockerignore`，并在 compose 中用 `${VAR:?message}` 强制运行期注入：
任一必需变量缺失，`docker compose up` 立即失败并点名变量，而不是启动一个永远返回 401/503 的容器。
V-12 已验证该行为。

---

## 6. 部署路径上发现的剩余风险

| ID | 风险 | 证据 | 严重度 |
|---|---|---|---|
| R-01 | Python `/api/health` **无鉴权**且返回租户数 | `roveagent/api/app.py:366-370`；实测返回 `"tenants":0` | 中。compose 中该端口不对外发布（仅 `expose`），但一旦有人 `-p 8788:8788` 即泄漏 |
| R-02 | TS `/api/health` **不探测 Python 运行时** | `src/app/api/health/route.ts` 只查数据库；Python 挂了它仍返回 `ok:true` | 中。容器健康检查因此无法反映真实可用性 |
| R-03 | `ENCRYPTION_SECRET` 与 `COZE_SUPABASE_SERVICE_ROLE_KEY` 存在复用风险 | `src/lib/crypto.ts:8` 缺 `ENCRYPTION_SECRET` 时回落 service_role key | 高。轮换 service_role 会让全部已落库凭据永久不可解密。已在 `docker/deploy.env.example` 显式要求二者不同，但代码层回落仍在 |
| R-04 | 启动 IIFE 未捕获异常 | `src/server.ts:43` 的 `void (async …)()`；`src/` 全局 0 个 `unhandledRejection` 处理器 | 中。任何启动期异常都会直接杀进程而非降级 |
| R-05 | 本机 Python 依赖版本与 pin 不一致 | 本机 fastapi 0.115.0 / starlette 0.38.6；`pyproject.toml` pin 0.133.1 / 1.3.1 | 低（仅本机）。镜像内按 pin 安装；也正是 U-3 必须由 CI 覆盖的原因 |
| R-06 | 镜像体积偏大（完整 `node_modules` + `.next`） | 无 `output: 'standalone'` | 低。功能性优先于体积的显式取舍 |
| R-07 | Python 运行时无 `ROVEAGENT_TEST_MODE` 生产护栏 | 该变量不被 `app.py` 读取，仅启动脚本使用 | 低。compose 默认 `false`，但无代码级拒绝 |

---

## 7. 一句话结论

运行链已建立并**在两个层面都跑通**。

原生进程层面：Python 运行时启动、`/api/health` 200、`/api/agent/chat` 200、
agent 真实发起工具调用并经 EnterpriseToolGate 判定（含一次真实拒绝）、
真实 TS 客户端模块到 Python 的链路 `link OK`、无凭据生产构建 exit 0。

容器层面：两个镜像均构建成功（exit 0）；`docker compose up` 起栈，
`roveagent` healthy 后 `web` 才启动；容器内 health 200、agent chat 200、
运行时端口不对外暴露、镜像内无任何凭据文件、两个容器均以非 root 运行；
Linux 上 `pip install -e "./roveagent[web]"` 首次被证明可行且装到确切 pin 版本。

过程中发现并修复两个只有真正构建/运行容器才会暴露的缺陷（B-01 UID 不匹配导致
`/data` 不可写、B-02 HEALTHCHECK 依赖基础镜像没有的 `curl`）。

**一项未解决**：容器内 agent 发起的工具调用没有产生任何 Gate 评估（F-C1，见 §3.4）——
原生环境同一请求产生 7 条。机制已部分定位（工具名修复路径），根因未确定。
在澄清之前，不应假定容器部署下 Gate 对 agent 发起的工具调用生效。
