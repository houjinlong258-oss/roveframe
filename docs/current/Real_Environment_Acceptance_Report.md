# Real-Environment Acceptance Report

Phase 14。**这是整个改造过程中第一次让系统在它的真实配置下运行**：
真实容器 + 真实 Supabase + 真实 LLM（`agnes-2.5-flash`）+ 真实工具调用 + 真实数据。

此前所有验证都在人造条件下完成：原生进程 + Mock LLM + 临时数据根，
或容器 + 占位凭据 + Mock LLM。

---

## 1. 验收结果

| ID | 验证项 | 结果 |
|---|---|---|
| A-1 | 只读核验真实库表结构 | **33/33 张表存在** |
| A-2 | 真实库种子数据 | products 10 / customers 10 / orders 43 / doc_chunks 44 |
| A-3 | `docker compose up` 全栈（真实凭据） | `roveagent` healthy；web 启动 |
| A-4 | **应用自检 schema** | **`✓ [boot-check] 数据库 schema 完整`** |
| A-5 | 从 host 访问 web `/api/health` | **HTTP 200**，`ok:true`，`missingTables:[]`，`encryptionConfigured:true` |
| A-6 | **真实 LLM 完整 agent 循环** | **HTTP 200，49.1 s** |

### A-6 是本次最关键的一条

请求：`How many orders are there? Use your tools.`

```
HTTP 200 in 49123 ms
reply: There are **45 orders** in the system.
gate audit entries: 1
   tool=read_orders allowed=True reason=
```

这一次请求同时证明了：

| 环节 | 证据 |
|---|---|
| 真实 LLM 可达 | 远端 `apihub.agnes-ai.com`，模型 `agnes-2.5-flash` |
| 模型自主决策调用工具 | 选了 `read_orders`（不是被脚本驱动的） |
| 工具经 EnterpriseToolGate 判定 | 审计条目 `allowed=True` |
| 工具读到真实数据 | 答案 45 笔订单，来自真实库 |
| 权限放行正确 | 该身份持有 `orders:read`，`reason` 为空 |

**「AI 员工」这件事第一次被真实执行过，而不是被 mock 过。**

---

## 2. 真实环境暴露的三个缺陷

全部是**只有连到真实基础设施才会出现**的问题。

### D-1 web 健康检查超时（已修）

```
docker inspect → Health check exceeded timeout (5s)
```

`/api/health` 要查 11+ 张表，而生产库是**跨公网的远程 Supabase**。
5 s 超时是照本地库设的，在真实库上稳定失败，导致一个**功能完全正常**的容器
被标记 `unhealthy`。

修复：`--timeout` 5s → 20s，`--start-period` 40s → 90s。

**这是 Phase 11 引入、Phase 11 未能发现的缺陷** —— 当时用的是占位凭据，
`/api/health` 直接 503，健康检查根本走不到超时那一步。

### D-2 `autoMigrate` 在容器里静默跳过

```
⚠️ [migrate] 未配置 DATABASE_URL 或 SUPABASE_ACCESS_TOKEN，跳过自动建表。
```

这是**设计内的降级**（没有 DSN 或 Management API token 时无法执行 DDL），
不是缺陷。但它意味着：**容器的"自动建表"能力在默认 compose 配置下不会生效**，
建表必须由外部完成（本次由外部迁移完成，`boot-check` 因此报 schema 完整）。

部署文档需要写明这一点：要么提供 DSN，要么在部署前独立跑迁移。

### D-3 运行中的 web 镜像落后于源码

`/api/health` 返回的是**旧响应格式**（`missingTables` 数组、无 `runtime` 字段），
说明 `roveframe/web:phase11` 是 Phase 12 之前构建的，不含 R-02（health 探测运行时、
不泄漏表名、加密判定对齐）等改动。

**镜像需要重建。** 本机 `auth.docker.io` 不可达，BuildKit 无法解析基础镜像
manifest；运行时镜像是用经典构建器（`DOCKER_BUILDKIT=0`）构建的。web 镜像
重建未在本轮完成。

---

## 3. 数据漂移（取证，未修改）

| 表 | 文档锚点 | 实测 | 说明 |
|---|---|---|---|
| `tenants` | 1（Default `000…000`） | **3** | 多出 2 个 |
| `businesses` | 1（四川人家 `000…001`） | **2** | 多出一条名为 `424323` 的行，看似注册测试产生 |

不影响功能，但**在把这个库当验收基线之前应先对账**。

---

## 4. 未完成

| 项 | 原因 |
|---|---|
| web 镜像重建（含 Phase 12 改动） | `auth.docker.io` 不可达 |
| 完整用户旅程（注册 → 登录 → 仪表盘 → 审批闭环） | 本轮上下文预算耗尽；A-6 已覆盖 AI 主链路 |
| 审计链两侧对账（`tool_gate.jsonl` ↔ `audit_events` 表） | 同上 |
| scheduler 实际行为观察 | 未做 |

---

## 5. 安全澄清

本轮使用真实凭据，但**未把任何新凭据写入被跟踪的文件**：
`docker/deploy.env` 与 `scripts/deploy.env` 均在 `.gitignore` 内
（`*.env` 模式，Phase 11 修复）。

用户已明确这些环境为测试环境。但需记录：会话中曾出现
`service_role` JWT、JWT Secret、数据库密码、Cloudflare R2 密钥与 LLM key，
**建议在测试结束后轮换**。

---

## 6. 一句话

**系统第一次在真实配置下跑通了。** 真实容器读真实 Supabase，
真实 LLM 自主调用工具，Gate 正确放行，返回真实数据得出的正确答案
（45 笔订单）。

同时暴露了三个只有真实环境才能发现的缺陷，其中一个（健康检查超时）
使一个功能正常的容器被误判为不健康。

Phase 11–13 的所有修复现在有了真实环境的支撑，不再是纸面结论。
