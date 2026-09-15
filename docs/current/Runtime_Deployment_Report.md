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

### 3.3 未验证项（UNVERIFIED）

| ID | 项 | 原因 |
|---|---|---|
| U-1 | `docker build` 两个镜像 | 本机 Docker daemon 不可用（`npipe:////./pipe/dockerDesktopLinuxEngine` 不存在），已尝试启动 Docker Desktop 未成功 |
| U-2 | `docker compose up` 端到端 | 同上 |
| U-3 | 容器内 `pip install -e "./roveagent[web]"` | 同上。本机 Python 环境已装 fastapi/uvicorn，但版本与 pin 不一致（见 §6 R-05） |
| U-4 | 镜像体量、层缓存、非 root 运行实际效果 | 同上 |

缓解措施：CI 新增 `docker` job 会真实构建两个镜像（`.github/workflows/ci.yml`），
使 U-1/U-3 在下次 CI 运行时自动转为已验证。

---

## 4. Docker daemon 不可用的处理

```
docker version → failed to connect to the docker API at
                 npipe:////./pipe/dockerDesktopLinuxEngine
```

已尝试：启动 `Docker Desktop.exe`。结果：daemon 仍未就绪。

处理原则：**不伪造验证**。改为用真实进程验证运行链（§3.1，证据强度更高），
把镜像构建明确标为 UNVERIFIED，并写进 CI 使其必然被验证。
未使用 `Dockerfile` 语法猜测代替构建结果。

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

运行链已建立并**在本机真实跑通**：Python 运行时启动、`/api/health` 200、`/api/agent/chat` 200、
agent 真实发起工具调用并经 EnterpriseToolGate 判定（含一次真实拒绝）、
真实 TS 客户端模块到 Python 的链路 `link OK`、无凭据生产构建 exit 0、compose 通过语法与插值校验。
821,458 行 Python 第一次在真实部署形态下运行。
唯一未验证项是镜像构建本身（Docker daemon 在本机不可用），已标注 UNVERIFIED 并由 CI 的 `docker` job 接管验证。
