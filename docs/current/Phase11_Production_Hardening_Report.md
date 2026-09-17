# Phase 11 — Production Hardening Report

范围：把 RoveFrame 从「代码资产」推进到「真实可部署 SaaS」。
本次不做新业务能力、不做新 Agent、不扩展 Skill。
所有数字来自本次实测输出；无法验证者标注 UNVERIFIED。

起点（审计原文）：*控制面已达生产级，执行面从未上线，工程化近乎空白。*

---

## 1. 完成项目

| # | 任务 | 状态 | 关键证据 |
|---|---|---|---|
| 1 | Git 与安全基线 | 完成 | 仓库边界建立；2 次提交；真实凭据零泄漏 |
| 2 | Runtime 部署 | 完成（镜像构建除外） | 12 项运行链验证，含真实 agent 工具调用与 Gate 拒绝 |
| 3 | Agent 启动性能 | 完成 | 热点**不是**审计假设；实测两个热点并修复 |
| 4 | Skill 收敛（方案 A） | 完成 | 安全能力吸收进安装路径；13 个新测试 |
| 5 | CI 生产门禁 | 完成 | 3 个 job；CI 从 4 步扩到 15 步 |
| 6 | 最终报告 | 完成 | 本文件 |

### 1.1 Task 1 — Git 与安全基线

| 项 | 结果 |
|---|---|
| 初始状态 | `git rev-parse --show-toplevel` → **父目录**；工作树 `??` 未跟踪；最后提交 2026-09-08 vs 文件 2026-09-15 |
| 边界决策 | 项目目录即 git 根；历史承接父仓库 `main`（`7a7f90d`），差异即 09-08 → 09-15 真实增量 |
| Baseline commit | `78e5684`，255 files，+53680 / −7193 |
| 凭据修正 | `scripts/deploy.env` 原先**未被忽略**，含 service_role key（219 字符）+ JWT secret（88 字符） |
| Secret 扫描 | 4 个 Supabase 值 + 2 个 RoveAgent 值在暂存索引中命中 **0** |

执行中修正了一个自身错误：`git fetch origin` 拉取两个分支后 `FETCH_HEAD` 指向首个分支而非 `main`，
索引一度被播种到 `agent/cprop_demo_readme`。改为显式 `origin/main` 后差异才正确。

### 1.2 Task 2 — Runtime 部署

新建 `Dockerfile`、`Dockerfile.roveagent`、`docker-compose.yml`、`docker/deploy.env.example`，并修正 `.dockerignore`。

`scripts/deploy.env` 原先不在 `.dockerignore` 中。除凭据入层外，更隐蔽的后果是
`supabase-client.ts` 以 `dotenv.config({ override: true })` 加载它 ——
镜像里的副本会**静默压过**容器注入的环境变量，使密钥轮换必须重建镜像。

### 1.3 Task 3 — Agent 启动性能

**审计假设被证伪。** 审计把 4.08 s 归因于 `get_tool_definitions()`（registry 遍历 + schema 过滤 + check_fn 探测）。
实测：

| 被怀疑项 | 实测 |
|---|---|
| `get_tool_definitions` | **0.71 ms/次**（5 次共 3.80 ms） |
| `ToolRegistry.get_definitions` | 未进入热点 |
| check_fn 探测 | 未进入热点 |

真正热点由 cProfile 与定向计时器定位，**两个，且都是网络/IO**：

| 热点 | 位置 | 实测成本 |
|---|---|---|
| H1 CA bundle 重复校验 | `roveagent/core/ssl_guard.py` → `_validate_bundle_path` | **780.7 ms/次**（2 个 bundle × ~0.39 s） |
| H2 本地端点探测无负缓存 | `roveagent/core/model_metadata.py` → `_query_local_context_length` | **3194.1 ms/次** |

对照实验（关键）：同一个 benchmark 换 base_url 即换结论 ——
说明 4 秒并非普遍的生产成本，而是**配置相关**。

| 场景 | 修复前 p50 | 修复后 p50 | 变化 |
|---|---|---|---|
| A：远程 provider（`api.openai.com`） | 1174.21 ms | **458.10 ms** | **−61%** |
| B：环回 mock（`127.0.0.1:8799`，即审计测量时的配置） | 6527.58 ms | **430.34 ms** | **−93%** |

修复方式：

- **H1**：以 `(解析路径, st_mtime_ns, st_size, require_substantial)` 记忆**成功**的 CA 校验结果。
  存在性/是否文件/最小体积三项检查**仍然每次执行**，因此被删除或截断的 bundle 依旧立即拒绝；
  只有"未变化且已知良好"的重复解析被跳过。失败的校验永不缓存。
- **H2**：原本只缓存**正值**（源码注释明确写了理由：启动竞态下必须重试）。
  改为正负都缓存，但**负值 TTL 更短**（15 s vs 30 s），既保留"数秒后重试"的语义，
  又消除同一进程内每次构造都重探的开销。降级形态是良性的：该窗口内回落到默认上下文长度。

在真实运行时上可见（V-5）：冷启动 7501 ms → 热态 **1668–2310 ms**。

### 1.4 Task 4 — Skill 收敛（方案 A）

`roveagent/skills/` 保留为**唯一公开入口**；只存在于 `roveagent/skills_market/`
（3,215 行，零生产引用）的安全能力被吸收到安装路径：

| 能力 | 吸收方式 |
|---|---|
| `scanner.py` | 每次安装对**原始制品目录**执行扫描；`scanner_error` 一律表现为拒绝，不表现为"干净" |
| `permissions.py` | 从清单 + 扫描结果推导能力请求，再与授权集判定（声明永不自动成为授权） |
| `versions.py` | 读取并暴露制品真实版本 |
| `sandbox.py` | 发布 `default_registry().describe()` 作为执行隔离现状（执行期契约，非安装期闸门） |

约束遵守：

- **未删除、未移动 `skills_market/**` 任何文件**（其 127 个测试以绝对路径导入）。
- **默认行为不变**。强制模式由 `ROVEAGENT_SKILL_ENFORCE` 控制，默认关闭。
  原因是一个真实产品决策：`install_from_directory(granted=())` 会拒绝一切，
  若默认强制，`/api/agent/skills/install` 将对所有请求返回 404。
  因此改为**可观测 + 可开启**，而不是静默翻转语义。
- 安全拒绝走既有的"返回 `None`"契约，不把新异常抛到 HTTP 层。
- 接缝位置严格放在 `marketplace.py` 两个 `return None` 守卫**之后**，
  否则 `api/path_safety_test.py` 的两个用例会从 `assertIsNone` 变成异常。

### 1.5 Task 5 — CI 生产门禁

| | 修复前 | 修复后 |
|---|---|---|
| 步骤数 | 4（install, ts-check, test, lint:build） | 15，分 3 个 job |
| Python 测试 | **完全缺失** | 795 用例，强制离线 |
| 生产构建 | **完全缺失** | `pnpm build`（占位凭据） |
| 容器构建 | **完全缺失** | 两个镜像真实构建 + compose 校验 |
| 迁移契约 / 生产扫描 / 样式 lint | **完全缺失** | 已加入 |

`ARCHITECTURE.md` 声称 CI 跑 8 项，其中 5 项此前并不存在 —— 现已补齐。

`roveagent` job 的意义超出跑测试：它是 Python 运行时依赖集**第一次在 Linux 上被安装**。
该运行时以 Linux 容器形态交付，此前安装路径从未被验证过。

---

## 2. 未完成项目

### 2.1 容器验证：由 UNVERIFIED 转为已验证（Docker daemon 可用后补做）

初稿时本机 Docker daemon 不可用，镜像构建标为 UNVERIFIED。daemon 可用后补做，**四项全部转正**：

| 原 ID | 项 | 结果 |
|---|---|---|
| U-1 | `docker build` 两个镜像 | **exit 0**。runtime 567 MB；web 1.57 GB |
| U-2 | `docker compose up` 端到端 | 栈启动成功；`roveagent` **healthy** 后 `web` 才启动 |
| U-3 | 容器内 `pip install -e "./roveagent[web]"` | **成功**，全部 manylinux wheel，无需编译器，装到确切 pin 版本 |
| U-4 | 非 root / 镜像内容 / 端口暴露 | 非 root（1000 / 10001）；镜像内无任何凭据文件；运行时端口不对外暴露 |

补做过程中发现并修复两个**只有真正构建/运行才会暴露**的缺陷：

- **B-01** `/data` 属主 UID（1000）与运行用户 UID（10001）不一致 → 容器启动后
  `PermissionError: [Errno 13] Permission denied: '/data/tenants'`，healthcheck 失败。
  改用单一 `ARG UID_RUNTIME` 同时驱动 `useradd` / `chown` / `USER`，消除漂移。
- **B-02** HEALTHCHECK 依赖 `curl`，而 `node:22-slim` 与 `python:3.13-slim` 都没有 →
  引入 apt 层，而构建时 Debian `bookworm/main` 索引不可达，构建直接失败。
  改为 Node 22 内置 `fetch` 与 Python stdlib `urllib` 探针，去掉 apt 层。

**这个结果验证了 UNVERIFIED 标注的价值**：两个缺陷读代码都看不出来，首次构建和首次运行各失败一次。

### 2.2 本次范围内仍未解决

| ID | 项 | 状态 |
|---|---|---|
| **F-C1** | 容器内 agent 工具调用**未经过 EnterpriseToolGate** | **未解决，根因未确定**。同机同消息对照：原生 7 条 gate 审计、容器 0 条且 `ROVEAGENT_GATE_TRACE=1` 零输出。机制已部分定位（`conversation_loop.py:7271-7276` 的工具名修复路径）。详见 `Runtime_Deployment_Report.md` §3.4 |
| U-5 | F-C1 根因排查 | 排查中 Docker Desktop 引擎无响应（API 500），重启后本次未恢复 |
| U-6 | 真实 Supabase 下的 web 容器端到端 | 有意未做：指向真实库会让 web 的 scheduler 对生产数据产生副作用 |

### 2.3 审计清单中本次未处理的项

本阶段聚焦"让它能部署"，以下审计项**未在本轮处理**：

| 审计 ID | 项 | 说明 |
|---|---|---|
| P0-4 | 监控 / 备份 / 回滚演练 | 全缺，需独立阶段 |
| P1-2 | `SandboxPluginLoader.load_all()` 从未进入调用链 | 插件仍未进入 Agent 工具列表 |
| P1-3 | 沙箱 L2 → L4 | 容器硬化参数仍为死代码 |
| P1-4 | Search 能力缺失 | TS 侧仍 0 命中 |
| P1-5 | RAG 绑定 Coze 嵌入 | 无抽象层 |
| P1-6 | 客户端断开不取消生成 | 未处理 |
| P1-7 | 无熔断 / 无 jitter / Supabase 无超时 | 未处理 |
| P1-8 | TS 路由级行为测试 | 未补 |
| P1-9 | 中文 PDF 缺字体 | 未处理 |
| P1-10 | `tokenCache` 无界增长 | 未处理 |
| 90 天项 | 删除 `gateway/`（约 40,000 行死代码） | 未处理 |
| P2/P3 | 13 处进程内状态、`withAuth` 死层、`getAuthContext` 死代码等 | 未处理 |

`roveagent/gateway/`（约 40,000 行不可达）、`skills_library/` 非业务分类等死代码
**一律未删除**（任务明确禁止删除未知代码）。

---

## 3. 修改文件

### 3.1 Commit `78e5684` — baseline（255 files）

该提交是整个工作树相对 09-08 的快照，**同时包含** Task 3 / Task 4 的代码改动与 Phase 1–10.7 的全部既有工作。
说明：本次先做测量与修复、后建立 git 基线，因此这两项改动落在基线提交内，而非独立提交。
已在 `Git_Security_Baseline_Report.md` 与本表中如实标注，未做历史重写。

本轮新增/修改且落在该提交中的文件：

| 文件 | 变更 |
|---|---|
| `roveagent/core/ssl_guard.py` | H1：CA 校验记忆化 + `clear_ca_bundle_cache()` |
| `roveagent/core/model_metadata.py` | H2：本地探测正/负缓存（15 s 负 TTL）+ 共享缓存助手 |
| `roveagent/skills/marketplace.py` | Plan A 接缝：`evaluate_install` / `install_ex`；`MarketSkill.path`/`.version` |
| `roveagent/skills/__init__.py` | 导出技能市场与安全面，确立唯一入口 |
| `roveagent/api/app.py` | 安装端点改走 `install_ex`，安全摘要落审计；`/market` 增加 `version` |
| `roveagent/skills/marketplace_test.py` | **新增**，13 个用例 |
| `scripts/bench_agent_build.py` | **新增**，agent_build benchmark |
| `.gitignore` | 按模式排除凭据文件 |
| `.dockerignore` | 同上 |
| `docs/current/bench-agent-build-*.json` | **新增** 5 份 benchmark 原始证据 |

### 3.2 Commit `6544cff` — Phase 11 交付物（9 files，+1091 / −5）

| 文件 | 变更 |
|---|---|
| `Dockerfile` | **新增** — Web 控制面镜像 |
| `Dockerfile.roveagent` | **新增** — Python 执行面镜像 |
| `docker-compose.yml` | **新增** — 两服务编排 |
| `docker/deploy.env.example` | **新增** — 部署变量模板 |
| `.github/workflows/ci.yml` | 4 步 → 3 job / 15 步 |
| `scripts/_verify_runtime_link.mts` | **新增** — TS→Python 链路验证 |
| `docs/current/Git_Security_Baseline_Report.md` | **新增** |
| `docs/current/Runtime_Deployment_Report.md` | **新增** |
| `next-env.d.ts` | Next.js 自动生成，dev 变体 → 生产构建变体 |

---

## 4. 测试结果

### 4.1 回归套件

| 套件 | 基线（改动前） | 改动后 | 结果 |
|---|---|---|---|
| Python（`pnpm test:python`） | 782 | **795**（+13 新用例） | **OK，0 失败** |
| TypeScript（`pnpm test`） | 621 | **621** | **621 pass / 0 fail** |
| `pnpm validate`（全链路） | — | 迁移契约 + ts-check + 双 lint + 621 测试 + 生产扫描 2206 文件 | **exit 0** |

Python 测试在 Task 3 修复后、Task 4 修复后各跑过一次，均为 OK。

### 4.2 部署运行链验证（12 项）

| ID | 验证项 | 结果 |
|---|---|---|
| V-1 | Python 运行时启动 | 成功 |
| V-2 | `GET /api/health` | **200** |
| V-3 | 无 key 调用 chat | **401**（符合预期） |
| V-4 | `POST /api/agent/chat`（冷） | **200**，7501 ms |
| V-5 | `POST /api/agent/chat`（热 ×3） | **2310 / 1708 / 1668 ms** |
| V-6 | **agent 工具调用 + EnterpriseToolGate** | **200**；gate 审计落地并**真实拒绝** |
| V-7 | `GET /api/agent/skills/market` | **200**，count=73 |
| V-8 | `GET /api/capabilities/health` | **200**，ready=true，73 capabilities |
| V-9 | **TS → Python 链路**（真实客户端模块） | **link OK**，exit 0 |
| V-10 | 生产构建（隐藏凭据 + 占位值） | **exit 0**，`dist/server.js` 146.67 KB |
| V-11 | `docker compose config` | **exit 0** |
| V-12 | compose 缺变量 | **exit 1**，点名缺失变量 |

V-9 明细：

```
PASS  roveAgentConfigured()     true
PASS  roveAgentHealth()         {"ok":true,"latencyMs":33,"detail":"runtime reachable"}
PASS  roveAgentChat()           reply 52 chars, agent=ceo
PASS  roveAgentChat() tool turn reply 64 chars
RESULT: link OK   exit=0
```

### 4.3 容器层面验证（12 项）

| ID | 验证项 | 结果 |
|---|---|---|
| V-B1/V-B2 | 两个镜像构建 | **exit 0**（567 MB / 1.57 GB） |
| V-B3 | Linux editable 安装 | 成功，确切 pin 版本（fastapi 0.133.1 等） |
| V-B4 | 镜像内是否含 `scripts/deploy.env` | **不存在**；`*.env` 命中 0 |
| V-B5 | `scripts/*.sql` 是否在镜像内 | 11 个，全部存在 |
| V-B6 | 非 root | `uid=1000(node)` / `uid=10001(rove)` |
| V-B7 | `docker compose up` | 成功；`service_healthy` 门生效 |
| V-B8 | 容器内 `/api/health` | **HTTP 200** |
| V-B9 | 容器内 `/api/agent/chat` | **HTTP 200**，`tool_turns=2` |
| V-B10 | 运行时端口是否对外暴露 | host 侧不可达（符合设计） |
| V-B11 | Gate 中间件是否装载 | `tool_execution` 链含（100 条策略，`fail_closed=True`） |
| V-B12 | 容器内 gate 直连判定 + 审计 | 成功写入 `/data/audit/tool_gate.jsonl` |
| **V-B13** | **容器内 agent 工具调用是否经 Gate** | **是 —— Phase 12 已解决，见 §4.3.1 更正** |

#### 4.3.1 对初稿的更正：F-C1 不是安全问题

本报告初稿在此处写过："容器内 agent 发起工具调用未经 EnterpriseToolGate
（原生 7 条、容器 0 条）"，并警告"在澄清之前不应假定 Gate 生效"。

**该结论已被推翻，警告过强，现予更正。**

Phase 12 用同一容器、同一 Mock、同一请求做了对照，把 agent 作为唯一变量：

| agent | Gate 审计增量 | `[gate-trace]` |
|---|---|---|
| `developer` | **+2** | `read_file`、`terminal` |
| `ceo` | **+0** | 无 |

`developer` 的工具调用**正常经过 Gate 并留下审计**。Gate 在容器里从未失效。

ceo 的 0 条是**症状而非原因**：它的 `business` toolset 被 tool_search 的渐进式
披露折叠，`read_sales` 等不再出现在 `valid_tool_names` 中，模型发出的 `read_file`
被判无效并丢弃 —— **没有任何东西被派发到执行链上，因此没有任何东西可被门控**。
原生之所以看起来"正常"，只是因为本机缺 `snowballstemmer`（`pyproject.toml` 的
pin 之一），使装配整段抛异常被跳过（`model_tools.py` 的 except 分支）。

这是真实缺陷 —— dev 与 prod 因一个可选依赖而暴露不同工具接口，且 agent 会在
什么都没执行的情况下返回"完成" —— 但它是**功能正确性**问题，不是门控绕过。

修复：`roveagent/toolsets.py` 的 `_ROVEAGENT_CORE_TOOLS` 纳入受治理的
RoveFrame 业务工具（治理模型以工具名为键，折叠即失去可寻址性）。
修复后容器内 ceo 的 Gate 审计由 **+0 → +7**，且判定正确：

| 工具 | 判定 | 依据 |
|---|---|---|
| `read_sales` | allowed | 已授予 `orders:read` |
| `terminal` | **denied** | 需要 `admin:process`，未授予 |
| `read_file` | allowed | 已授予 `files:read` |

### 4.4 一次方法学陷阱（记录在案）

容器验证中，compose **没有 publish** runtime 端口（只有 `expose`），
但我仍然从 host 访问 `127.0.0.1:8788` 得到了 200 —— 因为先前原生验证用的 uvicorn 进程**还在监听**。
差一点把原生进程的响应记成容器证据。

发现方式：检查 `Get-NetTCPConnection -LocalPort 8788` 的属主 PID，发现是宿主 python 而非容器。
处理：杀掉该进程 → 确认 host 侧确实不可达 → 改从容器网络内部取证。

这条与 §4.2 的 secret 扫描、以及"mock 回复文案不是证据"属同一类问题：
**结论必须能追到产生它的那个主体**，否则证据链是断的。

### 4.5 一次"声称 vs 实际"的核对

Mock LLM 的回复文案写着"所有工具调用均经 EnterpriseToolGate 判定"。
**这是脚本台词，不是证据**，因此独立核对：

1. `~/.roveagent/audit/tool_gate.jsonl`（79 条）最后写入时间 **2026-09-13**，近 10 分钟新增 **0** 条
   —— 早期几次不含工具调用的请求确实没有产生任何 gate 记录。
2. 改为触发真实工具调用后，配置的 `ROVEAGENT_ROOT/audit/tool_gate.jsonl` 新增条目，累计 **21 条**，
   全部为 `tool=read_sales, allowed=false, reason="permission denied: requires 'orders:read'"`。

结论：agent loop 真的发起了工具调用、真的经过 Gate、Gate 真的按权限拒绝。
default-deny 与权限判定在生产配置下是活的。

同类方法学问题在 Task 1 也出现过：第一轮 secret 扫描全报 0 命中，
实际是 `git grep --cached` 位置错误导致命令失败、错误被 `2>$null` 吞掉。
用已知存在字符串做阳性对照（`SERVICE_ROLE` → 19 files）后才发现并修正。
**任何"0 命中"结论都必须先有阳性对照。**

---

## 5. 剩余风险

### 5.1 高

| ID | 风险 | 证据 |
|---|---|---|
| R-03 | `ENCRYPTION_SECRET` 缺省时回落到 `COZE_SUPABASE_SERVICE_ROLE_KEY` | `src/lib/crypto.ts`。轮换数据库凭据会让全部已落库凭据**永久不可解密**。已在 `docker/deploy.env.example` 显式警告并要求二者不同，但代码层回落仍在 |
| G-03 | `service_role` 曾长期处于未忽略状态 | 是否曾泄漏**未经验证**；建议轮换 |

### 5.2 中

| ID | 风险 | 证据 |
|---|---|---|
| R-01 | Python `/api/health` 无鉴权且返回租户数 | `roveagent/api/app.py`。compose 中不对外发布，但 `-p 8788:8788` 即泄漏 |
| R-02 | TS `/api/health` 不探测 Python 运行时 | Python 挂了它仍返回 `ok:true`，容器健康检查无法反映真实可用性 |
| R-04 | 启动 IIFE 未捕获异常 | `src/server.ts` 的 `void (async …)()`，`src/` 全局 0 个 `unhandledRejection` 处理器 |
| P-01 | Skill 安全**强制模式默认关闭** | `ROVEAGENT_SKILL_ENFORCE` 默认 false。扫描始终执行并记录，但"据此拒绝"需显式开启。这是一个待产品决策的开放项 |
| P-02 | H2 负缓存引入 15 s 语义变化 | 原实现显式声明"失败永不缓存"。现改为 15 s 负 TTL，降级形态良性（回落默认上下文长度）且自愈，但属行为变更 |
| P-03 | benchmark 使用环回 mock base_url | 场景 B 的数字与该配置绑定。已在报告中同时给出远程场景对照，避免以偏概全 |

### 5.3 低

| ID | 风险 |
|---|---|
| R-05 | 本机 Python 依赖版本与 pin 不一致（fastapi 0.115.0 vs 0.133.1）——仅本机，镜像内按 pin 安装 |
| R-06 | 镜像体积偏大（完整 `node_modules` + `.next`，无 `output: 'standalone'`）——功能性优先的显式取舍 |
| R-07 | Python 运行时无代码级 `ROVEAGENT_TEST_MODE` 生产护栏（仅启动脚本使用该变量） |
| G-01 | 父仓库仍把本目录视为未跟踪；是否归档父仓库旧副本需人工决定 |
| G-02 | `.cozeproj/prototype/web/*.html`（`AGENTS.md` 声明的视觉唯一标准）不在本工作树，但可从 `7a7f90d` 取回 |
| G-05 | `probe_c.txt`（内容 `value = 42`）为无害残留，已加入 `.gitignore`，未删除 |

---

## 6. 下一阶段建议

按"解锁价值 / 成本"排序。

### 立即（1–2 天）

1. **让 CI 的 `docker` job 跑一次并通过。** 这会把 U-1/U-2/U-3 三项 UNVERIFIED 一次性转为已验证，
   是当前最高性价比的动作。
2. **轮换 `COZE_SUPABASE_SERVICE_ROLE_KEY` 与 `COZE_SUPABASE_JWT_SECRET`**，并为 `ENCRYPTION_SECRET`
   设置一个独立值（先迁移已落库凭据，再断开 `crypto.ts` 的回落）。
3. **`docker compose up` 起一套真实环境**，用 `scripts/_verify_runtime_link.mts` 与
   `scripts/bench_agent_build.py` 在容器内复测，确认容器内性能与裸机一致。

### 短期（1–2 周）

4. **给 Skill 强制模式做一次产品决策**（P-01）。当前是"记录不阻止"。
   建议先让 `/api/agent/skills/install` 的响应把 `security.blocking` 暴露到设置页，
   运维看到真实发现后再开 `ROVEAGENT_SKILL_ENFORCE=1`。
5. **TS `/api/health` 合并运行时探测**（R-02），使容器健康检查反映真实可用性。
6. **给 `src/server.ts` 的启动 IIFE 加 `.catch()` 与全局 `unhandledRejection` 处理器**（R-04）。
7. **补可观测性最小集**：结构化日志 + request-id 贯通 + 4 个指标。这是 P0-4 的第一块。

### 中期（1–3 个月）

8. **监控 / 备份 / 回滚演练**（审计 P0-4）。回滚能力本轮已恢复（有 git 历史），但备份与演练仍全缺。
9. **接通 `SandboxPluginLoader.load_all()`**（P1-2），让插件真正进入调用链；
   随后沙箱 L2 → L4（P1-3）。
10. **删除 `roveagent/gateway/` 死代码（约 40,000 行）**。
    本轮未删（任务禁止删除未知代码），但审计面收窄的收益明确。建议先摘除 `tools/*` 惰性 import 再删。
11. **Search 能力建设**（P1-4）与 **RAG 嵌入 provider 抽象**（P1-5）——产品关键缺口。

### 建议的验收标准（沿用本轮方法）

不以"代码增加"验收，而以"真实运行能力增加"验收。每条结论必须能追到：

- 一条命令及其原始输出；
- 或一个可复跑的脚本（`scripts/bench_agent_build.py`、`scripts/_verify_runtime_link.mts`）；
- 无法验证时写 UNVERIFIED，不用推断代替证据；
- 任何"0 命中 / 无问题"结论必须有阳性对照。

---

## 7. 一句话结论

执行面第一次真正上线：Python 运行时启动、`/api/health` 200、`/api/agent/chat` 200、
agent 真实发起工具调用并被 EnterpriseToolGate 按权限拒绝、真实 TS 客户端到 Python 的链路 `link OK`。
源码进入版本控制并获得回滚能力，真实凭据零泄漏，CI 从 4 步扩到 15 步并首次覆盖构建与容器。
性能主瓶颈被证伪后重新定位并修复：远程场景 −61%、环回场景 −93%。
唯一未验证项是镜像构建本身（本机 Docker daemon 不可用），已标注并交由 CI 验证。
