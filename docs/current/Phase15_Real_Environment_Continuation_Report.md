# Phase 15 — Real-Environment Continuation Report

Phase 15。接续 Phase 14 的真实环境验收，处理其"未完成"清单，并对其
**已宣布通过的结论**做一次负向复核。

结果分两部分：一部分是 Phase 14 未做的项（镜像重建、端到端旅程、延迟分解、
数据对账）；另一部分是复核中**推翻了 Phase 14 两条通过结论**（表结构 33/33、
`✓ boot-check schema 完整`）。两条都是"永远通过的探针"造成的假阳性。

所有数字来自本次实测命令输出。未测量者标 UNVERIFIED。

---

## 1. 一句话结论

web 镜像重建完成（阻塞三轮的项），端到端用户旅程 30/30 通过。
但复核发现 Phase 14 的两条通过结论**建立在不能失败的探针上**，
真实库实际比它报告的更完整（51/51），而生产自检**不具检测能力**。
另发现 5 个代码依赖的列在任何自动迁移路径下都不存在。

---

## 2. 基线（本次实测，动手之前）

| 项 | 声明基线 | 本次实测 | 判定 |
|---|---|---|---|
| git HEAD | `34647df` | `34647df`，工作树干净 | 一致 |
| Python 测试 | 812 OK（4 skip） | **812 OK（4 skip）** | 一致 |
| TypeScript 测试 | 661，0 失败 | **661（660 pass / 1 skip / 0 fail）** | 一致 |
| `pnpm validate` | exit 0 | **exit 2** | **不一致 —— 见 §3** |
| 容器 | web unhealthy | `roveframe/web:phase11`，`Health check exceeded timeout (5s)` | 一致 |

---

## 3. `pnpm validate` 在 HEAD 上不可能通过

`package.json` 的 `validate` 链条是
`validate:migrations && ts-check && lint:build && lint:style && test && scan:production`。
它在 `ts-check` 一步就断：

```
scripts/_verify_real_database.mts(129,19): error TS2488:
  Type '{}' must have a '[Symbol.iterator]()' method that returns an iterator.
```

该文件是 Phase 14 的交付物（commit `2a331ad`），**从落地起就带着这个类型错误**。
因为 `validate` 用 `&&` 串联，`ts-check` 失败意味着**后面 5 步从未运行过**，
`exit 0` 在 HEAD 上不可达。

根因不是那一行的问题，而是类型声明写成了"返回类型的联合"：

```ts
select(columns: string, opts?: {...}): Promise<CountResult>
  & { limit(n: number): Promise<LimitResult> }   // 联合，TypeScript 取第一个匹配的签名
```

TypeScript 对这种写法取第一个匹配签名，于是 `await ...select(col).limit(5)` 被解析成
`CountResult`，`data` 是 `unknown`，`.limit()` 也不存在。正确写法是**重载**。

修复：把 `select` 拆成两个重载签名（`{count:'exact',head:true}` → `Promise<CountResult>`；
其余 → 可链式构造器）。修复后 `ts-check` exit 0。

> 这类错误的性质值得记录：它不产生运行期故障，只让**质量门自身**失效。
> 与 §4 的探针问题同属一类 —— 保护机制坏了，比没有保护更危险，因为它会让人以为有保护。

---

## 4. 推翻了 Phase 14 的两条通过结论

### 4.1 Phase 14 原文（保留）

> | A-1 | 只读核验真实库表结构 | **33/33 张表存在** |
> | A-4 | **应用自检 schema** | **`✓ [boot-check] 数据库 schema 完整`** |

两条都被当作"通过"证据写进了验收报告。

### 4.2 旧探针形态不能失败

Phase 14 的探针是：

```ts
const { error } = await client.from(table).select('*', { count: 'exact', head: true });
//                                                ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
```

`scripts/_verify_probe_validity.mts` 的对照实验（同一调用形态，三个确定性样本）：

| table | status | count | error |
|---|---|---|---|
| `tenants`（阳性对照，确定存在） | 200 | 3 | - |
| `orders`（阳性对照，确定存在） | 200 | 43 | - |
| `zzz_definitely_not_a_table_9f3a`（**阴性对照，绝不存在**） | **204** | **null** | **-** |
| `public.also_not_real_7b1c`（**阴性对照，绝不存在**） | **204** | **null** | **-** |

**阴性对照与阳性对照在 `error` 上无法区分**：`head: true` 让 PostgREST 对不存在的表
返回 204 而不是 404，`error` 恒为 `null`。因此 `if (error)` 恒为假，
每一张表都被判为"存在"。

一个永远通过的探针，其"33/33 存在"不构成证据。

### 4.3 生产自检同样 fail-open（不只是脚本问题）

`src/lib/boot-check.ts:29` 用的是**同一形态**。直接调用生产函数
（`scripts/_prove_bootcheck_failopen.mts`）：

| 检查 | 结果 |
|---|---|
| `runBootChecks()` 报缺失项 | **0 项** |
| 同一形态 + `zzz_definitely_not_a_table_9f3a` | `missing=false` —— **未检出** |
| 同一形态 + `public.also_not_real_7b1c` | `missing=false` —— **未检出** |
| 结论 | 生产形态无法检出缺失表 → **自检不具检测能力** |

同一形态还出现在 `src/lib/scheduler.ts:46`（`cron_state` 就绪判定）：
`_cronStateReady` 恒为 `true` ⇒ `schedulerHealth().degraded` 恒为 `false`
⇒ `/api/health` 永远不会上报调度器降级。

该条已实测（`scripts/_prove_scheduler_failopen.mts`，同一形态 `select('key',{count:'exact',head:true})`）：

| table | status | `!error`（即判定"就绪"） |
|---|---|---|
| `cron_state`（真实存在） | 200 | true |
| `zzz_definitely_not_a_table_9f3a`（**绝不存在**） | **204** | **true** |
| `public.also_not_real_7b1c`（**绝不存在**） | **204** | **true** |

即：`cron_state` 缺失时，修改前的 scheduler 仍会判定"就绪"，
一路往下跑，直到后续真实读取处才失败 —— 而 `health` 的 `degraded` 全程为 `false`。

### 4.4 修正后的真实表结构：51/51 全部存在

用（已证明可败的）`select('id')` 列投影探针，对 `schema.ts` 声明的**全部** 51 张表实测
（`scripts/_verify_schema_inventory.mts`）：

| 项 | 值 |
|---|---|
| 阴性对照（n=2） | 均 404 ✓ 探针可败 |
| 阳性对照 `tenants` | 200 ✓ |
| schema.ts 声明 | 51 张 |
| **真实库存在** | **51 张** |
| 缺失 | **0 张** |
| 种子数据未达下限的表 | 无 |

**真实库比 Phase 14 报告的更完整。** Phase 14 的清单只查 33 个名字，其中 4 个
（`documents` / `suppliers` / `purchase_orders` / `marketing_campaigns`）
在 `schema.ts` 里根本不存在，另有 22 张真实表从未被覆盖。实测 51/51。

### 4.5 一个中途自己的误报（记录，避免被当成结论）

`scripts/_verify_data_drift.mts` 首次运行时，上述 4 张表报
`Could not find the table 'public.<name>' in the schema cache`。这曾被当作
"表缺失"的线索。逐项诊断（`scripts/_diagnose_table_vs_column.mts`）后：

| table | `select('*', head)` | `select('business_id')` |
|---|---|---|
| `documents` | 204 | PGRST205 Could not find the table |
| `knowledge_docs`（真名） | 200 | OK 列存在 |

结论：那 4 张表**不存在**（名字是笔误），但报错文本把"列不存在"说成了"表不存在"。
即那次 ERR 是**真结论 + 误导性文案**，不是探针故障。与本节的 fail-open 是两回事。

---

## 5. 代码依赖的列没有任何迁移路径会创建它们

### 5.1 症状（真实容器日志，重复出现）

```
[agent/chat] runtime metadata columns unavailable;
  run scripts/migrate-runtime-metadata.sql:
  Could not find the 'runtime_agent' column of 'chat_sessions'
```

### 5.2 取证

| 事实 | 证据 |
|---|---|
| 代码每轮对话都写这 5 列 | `src/app/api/agent/chat/route.ts` 的 `runtimeMetadata` |
| 这 5 列的 DDL 只在一个文件里 | `scripts/migrate-runtime-metadata.sql` 含 `runtime_agent`；其余 8 个 `migrate*.sql` **均不含** |
| 该文件**不在**自动迁移清单 | `src/lib/migration.ts` 的 `MIGRATION_FILES` 只列 3 个文件，不含它 |
| CI 不拦 | `scripts/verify-migrations.mjs` 只断言**表名**与索引口径，从不比对列 |

后果：`runtime_mode / runtime_agent / runtime_request_class / runtime_tool_intent / runtime_at`
**从未被写入过**。而这个迁移存在的全部目的，就是让"这条回答是 Runtime 出的还是
TS 降级出的"在数据层可查证（Phase 12 Step 3 的审计目标）。

`autoMigrate` 在 compose 默认配置下还会因缺 `DATABASE_URL` 而整段跳过（Phase 14 的 D-2），
但那是**设计内降级**；本项不同 —— 即便配了 DSN 也仍然不会建这 5 列。

### 5.3 修复

把 `scripts/migrate-runtime-metadata.sql` 加入 `MIGRATION_FILES`（该文件全部使用
`ADD COLUMN IF NOT EXISTS`，幂等，可安全入链）。

### 5.4 本机无法应用该迁移

本机 `docker/deploy.env` 无 `DATABASE_URL` / `SUPABASE_ACCESS_TOKEN`，
凭据库（vault）也无 Supabase 条目。**UNVERIFIED：迁移在真实库上的效果未在本轮验证。**
已在报告中列为部署前置动作。

---

## 6. 数据漂移：已对账，来源已确定

`scripts/_verify_data_drift.mts`（只读）实测：

| 表 | 文档锚点 | Phase 14 实测 | Phase 15 实测 | 取证 |
|---|---|---|---|---|
| `tenants` | 1 | 3 | **6** | 见下 |
| `businesses` | 1 | 2 | **5** | 见下 |

多出的行不是随机脏数据，**来源已确定**：

| tenant | name | 来源 | 引用计数 |
|---|---|---|---|
| `688fa1e3…` | `rls-probe` | RLS 策略测试残留（2026-09-09） | 全表 0 |
| `3fffce61…` | `424323` | 一次注册测试（2026-09-09） | 仅 1 个 business，业务表全 0 |
| `0c992276…` / `1fad2e67…` / `60d54948…` | `E2E Phase15 …` | **本轮端到端验收新建**（2026-09-17） | 业务表全 0 |

即计划外 tenant 共 **5** 个、计划外 business 共 **4** 个，锚点
`000…000` / `000…001` 完好，种子数据完好（products 10 / customers 10 / orders 43）。

根因：`/api/auth/signup` 的设计就是**每次注册建一个新 tenant + 一个新 business**
（`route.ts` 步骤 1–2），因此验收脚本每跑一次就留下一条孤儿链。
这不是缺陷，是"新注册商家"的正常语义。

**本轮新增的 3 条是本次验收的产物**，与 Phase 14 遗留的 2 条性质相同。
对账结论：漂移不影响功能（锚点 `000…000` / `000…001` 完好，种子数据完好），
但**这个库不适合直接当"干净基线"**；若要作为基线，需先清理测试残留。

---

## 7. 端到端用户旅程：30/30 通过

`scripts/_verify_e2e_journey.mts`，目标 `http://127.0.0.1:5055`（重建后的 phase13 镜像）。

| 段 | 覆盖 | 结果 |
|---|---|---|
| 服务可达 | `/api/health` 200 | PASS |
| **R-02 契约** | 不泄漏表名、`runtime` 为一等字段 | PASS |
| 会话守卫（阴性对照） | 匿名 `/api/auth/me` 必须 401 | PASS（401） |
| 注册 | 建 tenant + business + auth user，种 cookie | PASS（201） |
| 会话生效 | `/api/auth/me` 200，身份正确 | PASS |
| 登录 | 正确密码 200 | PASS |
| 登录（阴性对照） | 错误密码必须 401 | PASS（401） |
| 阴性对照副作用 | 不破坏已建立会话 | PASS |
| 仪表盘 | `/api/dashboard` 200，7 个字段 | PASS |
| **AI 对话** | SSE 200，`x-request-id` / `x-session-id` 贯通 | PASS |
| **运行时** | `runtime_status.mode = roveagent`（非降级） | PASS |
| **工具调用** | 产生 `calling_tool` 事件（`read_orders`/`read_sales`） | PASS |
| **门控审计** | `/data/audit/tool_gate.jsonl` 增量 +N | PASS |
| **审批闭环** | 创建 → 列表可见 pending → 批准 → `executed` + 执行结果 | PASS |
| 审批幂等 | 二次批准不产生第二次执行 | PASS |
| 审计两侧 | `tool_gate.jsonl` 与 `audit_events` 均在真实写入 | PASS |

**合计 30/30。**

### 7.1 与 A-6 的差异值得单独说明

Phase 14 的 A-6 答"45 orders"；本轮同提示词答 **"0 orders"**。这不是回归：

| | Phase 14 | Phase 15 |
|---|---|---|
| 请求者 | Default tenant（有 43 笔种子订单） | 本轮**新注册**的商家（0 笔订单） |
| 答案 | 45 orders | 0 orders |

两个答案都对，因为问的是不同租户的数据。本轮答案反而多了一层证据：
它证明工具读取是**按租户隔离**的，而不是全局读表。

### 7.2 途中一次真实限流（记录，不是缺陷）

首轮运行 28/29，唯一失败是"登录返回 200 → HTTP 429"。根因是**我自己的脚本顺序**：
先跑了一次错误密码的阴性对照，该次失败按设计计入该 email 的**指数退避**，
紧接着的正确密码登录因此被拒。

修正做法不是放宽断言，而是把阴性对照移到成功登录**之后**、并改用一次性 email；
同时对直连容器的请求显式带上 `x-forwarded-for`（否则 `getClientIp()` 回落到字面量
`'unknown'`，所有无代理请求共用一个限流桶）。修正后 30/30。

---

## 8. 延迟分解（A-6 的 49.1 s 拆开看）

`scripts/_verify_latency_breakdown.mts`（SSE 事件打点）与
`scripts/_verify_preflight_cost.mts`。

### 8.1 运行时本身不是瓶颈

| 测量 | 值 |
|---|---|
| 容器内 python 直连运行时 `/api/health`（进程内计时） | **35.7 / 38.3 / 36.6 ms** |
| web 侧 `/api/health` 报 `runtime.latencyMs` | **3–4 ms** |

### 8.2 首次请求含显著冷启动

| 次序 | 「请求发出 → 首个 SSE 事件」 |
|---|---|
| 第 1 次 | **10394 ms** |
| 第 2 次（同构请求） | **3519 ms** |
| 差 | **−6875 ms** |

即：**约 6.9 s 是一次性冷启动成本**，热态首事件约 3.1–3.5 s。

### 8.3 工具执行只占约 12%

工具类请求（热态，总 15940 ms）：

| 区间 | Δ | 归属 |
|---|---|---|
| t0 → 首事件 | 5478 ms | 前置 + 模型首 token（含冷启动） |
| → `calling_tool:read_orders` | 2425 ms | 模型决定调工具（**LLM 往返**） |
| → `tool_done:read_orders` | **775 ms** | **工具执行（真实库查询）** |
| → `tool_done:read_sales` | **1249 ms** | **工具执行** |
| → `done` | 4536 ms | 终稿生成（**LLM 往返**） |
| → 流关闭 | 1470 ms | 收尾 |
| 合计 | 15940 ms | |

| 归类 | 毫秒 | 占比 |
|---|---|---|
| 工具执行（真实读库） | 2024 | **12.7%** |
| LLM 往返（决策 + 生成） | 6961 | 43.7% |
| 前置 + 冷启动 + 收尾 | 6955 | 43.6% |

**结论：延迟由 LLM 往返与冷启动主导，工具执行不是瓶颈。** 优化方向应是
热进程/预热与模型侧，而不是数据库或工具层。这与 Phase 11 时期把
`get_tool_definitions()` 当成热点的判断再次相反。

---

## 9. P1-2 插件接通：结论被实测推翻

Phase 12 把 P1-2 记为"`SandboxPluginLoader.load_all()` 从未进入调用链"，Phase 15 任务书
沿用该结论。实测不成立。

| 检查 | 结果 | 证据 |
|---|---|---|
| `load_all()` 是否有调用方 | **有** | `clisupport/plugins.py:7135`（经 `_load_community_plugins_into_sandbox`） |
| 该调用方是否在链上 | 是 | `_ensure_plugins_discovered()` → 800+ 处引用，含 `media_hub`/`browser_tool`/`web_tools`/`voice_mode` 等 |
| **沙箱候选集实际大小** | **0** | 容器内实测 |
| 运行时插件总数 | 54，**全部 `bundled`**，全部 enabled | `/api/plugins` |
| 社区插件数 | **0** | 同上 |

`discover_candidates()` 的定义是"**被信任策略拒绝的社区插件**"
（`error.startswith(TRUST_REFUSAL_PREFIX)`）。本部署**没有社区插件**，
因此候选集恒为空，`load_all()` 无事可做。

**这不是缺口，是空集。** 把 `load_all()` 再挂到启动路径上不会改变任何行为
（仍加载 0 个插件），只会增加启动开销。

判定：P1-2 在**本部署配置下无可接通的对象**。它变成真问题的那一刻是
"有社区插件被拒绝且应当沙箱加载"时；届时现有代码已经能处理。
**本轮未做任何插件装配改动。**

对 `plugin_sandbox.jsonl` 缺失的解释也由此确定：该审计文件只在**真的沙箱加载了插件**时
才创建；候选集为空 ⇒ 从不创建。这与"加载器从未被调用"是两回事。

---

## 10. scheduler 实际行为：在跑，但健康端点看不见它

### 10.1 观察

| 观察项 | 结果 |
|---|---|
| `/api/health` 的 `scheduler.cronStateReady` | **恒为 `null`**（连续 3 次，间隔 4s） |
| `_cronStateReady` 的置位条件是 tick 执行 `ensureCronState()` | `scheduler.ts:371` |
| `cron_state` 表实际内容 | **12 行**，含 `imap_sync.<tenant>.<business>` 与 `square_sync_throttle.*` |
| 最新写入时刻 | `2026-09-17T14:52:37Z`（web 容器启动于 `14:52:19Z`，**18 秒后**） |
| 其余 worker 痕迹 | `agent_tasks` 10 行 `active` |

### 10.2 判定

`cron_state` 的写入时刻与容器启动时刻吻合 ⇒ **scheduler 的 tick 确实执行了**，
`runScheduledJobsInner()` 一路跑到了为每个 tenant/business 读写水位线。

而 `/api/health` 报 `cronStateReady: null` ⇒ health 路由里的 scheduler 模块
**与真正在跑的那个不是同一个模块实例**。

这正是 Phase 12 §6 记录过的"进程级共享实为**模块实例级**"的具体后果：
health 里的 `scheduler` 字段**不代表真实调度器**。因为 `degraded` 由这个
未初始化的实例算出，`/api/health` **永远不会上报调度器降级** —— 即使调度器真的死了。

### 10.3 本轮未修

修法有两条（把状态落库由 health 读；或把调度器提为独立进程），两者都是
**架构决策**，超出本轮范围。已如实记录，未做改动。

---

## 11. 本轮修复清单

| # | 文件 | 改动 | 负向对照 |
|---|---|---|---|
| 1 | `docker-compose.yml` | web 镜像 `phase11` → `phase13` | 容器由 unhealthy → **healthy** |
| 2 | `src/lib/boot-check.ts` | 存在性探测改用列投影（每表配 `PROBE_COLUMN`） | 阴性对照 + `tests/boot-check-failopen.test.ts`（4 例，注入回归后变红） |
| 3 | `src/lib/scheduler.ts` | `cron_state` 就绪判定改用列投影 | 同上测试覆盖 |
| 4 | `src/lib/migration.ts` | `MIGRATION_FILES` 纳入 `migrate-runtime-metadata.sql` | `tests/migration-column-coverage.test.ts`（4 例，注入回归后 2 例变红） |
| 5 | `scripts/_verify_real_database.mts` | 修 `select` 重载类型（解 `ts-check` 阻塞） | `ts-check` exit 0；Next 构建通过 |
| 6 | `docker-compose.yml` | web 服务纳入 `ENCRYPTION_SECRET_PREVIOUS`（原先被白名单静默丢弃） | 容器内变量出现；两行凭据由"解不开"变为可解密（§18） |
| 7 | `docker/deploy.env`（gitignored） | 设置 `ENCRYPTION_SECRET_PREVIOUS`（= 历史派生密钥） | 同上 |

**验证边界**：`docker/deploy.env` 与 compose 的运行时行为已实测，但该文件不进 git，
因此 **compose 的改动本身没有被 `pnpm validate` 覆盖**（validate 不解析 compose 语义）。
镜像内容未因此变化（该变量是运行时注入），故未触发镜像重建。

### 11.1 本轮新增的取证 / 验收脚本（只读为主）

| 脚本 | 作用 |
|---|---|
| `scripts/_verify_probe_validity.mts` | **探针有效性对照实验**（三形态 × 阳性/阴性样本） |
| `scripts/_prove_bootcheck_failopen.mts` | 直接调用生产 `runBootChecks()` 证明 fail-open |
| `scripts/_prove_scheduler_failopen.mts` | 证明 `cron_state` 探测同样 fail-open |
| `scripts/_verify_schema_inventory.mts` | 修正版表结构核验（51 张，带对照） |
| `scripts/_verify_table_probe_control.mts` | 旧探针的阴阳性对照 |
| `scripts/_verify_probe_column_choice.mts` | 收紧前的列选型验证（先验证后修改） |
| `scripts/_diagnose_table_vs_column.mts` | 区分"表缺失"与"列缺失" |
| `scripts/_verify_data_drift.mts` | 数据漂移取证（含引用计数） |
| `scripts/_verify_counts.mts` | 计数快照（报告数字来源） |
| `scripts/_verify_e2e_journey.mts` | 端到端用户旅程（30 项断言，**会写测试数据**） |
| `scripts/_verify_latency_breakdown.mts` | SSE 事件时间戳延迟分解 |
| `scripts/_verify_preflight_cost.mts` | 前置开销 / 冷启动分解 |
| `scripts/_observe_scheduler.mts` | scheduler 实际行为观察 |
| `scripts/_diagnose_module_shape.mts` | CJS 互操作下模块导出形状 |
| `scripts/_verify_column_names.mts` | 用 `select('*')` 取真实列名（发现文档列名不存在） |
| `scripts/_container_decrypt_check.cjs` | **容器内**逐个候选密钥试解密（密钥不出容器，不打印明文） |
| `scripts/_diagnose_decrypt_failures.mts` | 宿主侧解密失败定位 |
| `scripts/_verify_model_assign.mts` | `model_assign` 与 provider 配置关联 |
| `scripts/_verify_settings_scope.mts` | settings 行与 tenant 归属对照 |

### 11.1 两处修复的负向验证（本项目规矩）

"永远通过"的守卫比没有守卫更危险，因此两个新守卫都验证了**它们能失败**：

| 守卫 | 注入的故障 | 结果 |
|---|---|---|
| `boot-check-failopen` | 把 `select(column)` 改回 `select('*',{head:true})` | **1 例变红**；还原后 4/4 绿 |
| `migration-column-coverage` | 从 `MIGRATION_FILES` 移除 runtime-metadata | **2 例变红**；还原后 4/4 绿 |

---

## 12. 回归结果

| 套件 | Phase 14 末 | Phase 15 末 | 结果 |
|---|---|---|---|
| Python | 812 | **812** | OK（skipped=4） |
| TypeScript | 661 | **682**（+21） | 681 pass / 1 skip / **0 fail** |
| `pnpm validate` | **不可达（exit 2）** | **exit 0** | 迁移契约 + ts-check + 双 lint + 测试 + 生产扫描 |
| 生产扫描 | — | 2253 文件通过 | — |

新增 21 个 TS 用例：

| 文件 | 数量 | 负向验证 |
|---|---|---|
| `tests/boot-check-failopen.test.ts` | 4 | 注入回归后 **1 例变红** |
| `tests/migration-column-coverage.test.ts` | 4 | 注入回归后 **2 例变红** |
| `tests/scheduler-health-visibility.test.ts` | 5 | 注入回归后 **1 例变红** |
| `tests/platform-fallback-credentials.test.ts` | 8 | 注入初版抛错实现后 **2 例变红** |

**4 个新守卫全部验证过"它们能失败"。**

---

## 13. web 镜像重建（本轮的首要阻塞项）

| 项 | 值 |
|---|---|
| 镜像 | `roveframe/web:phase13` |
| 构建器 | 经典构建器（`DOCKER_BUILDKIT=0`）—— 本机 `auth.docker.io` 仍不可达 |
| 构建结果 | 成功。前两次被 `next build` 的构建期 `tsc` 拦下（暴露了 §3 与 §4 之前的问题），一次因 `sha256:d9787cc3…` 层缓存损坏失败，`docker builder prune -f` 后重建成功 |
| 容器 | `roveframe-web-1`，`Up (healthy)` |

**构建踩坑记录（两条，都可复现）**：

1. `docker builder prune -f` **清不掉经典构建器的层存储** —— 清完仍报
   `failed to export image: No such image: sha256:…` 与
   `failed to copy files: … symlink … no such file or directory`。
   必须用 `docker build --no-cache`。
2. `--no-cache` 会走 BuildKit，于是又撞上 `auth.docker.io`：
   `failed to fetch oauth token: … dial tcp … connectex`。
   `DOCKER_BUILDKIT=0` 必须与 `--no-cache` **同时**给出。
   另注：每次 `pwsh` 调用是独立进程，`$env:` 不跨调用保留。

**R-02 契约在真实容器上得到验证**（这是 `phase11` 缺失的部分）：

```json
{"ok":true,
 "database":{"ok":true,"missingCount":0},
 "runtime":{"ok":true,"status":"ok","latencyMs":3,"detail":"runtime reachable"},
 "scheduler":{"cronStateReady":null,"degraded":false,...},
 "encryptionConfigured":true}
```

| 契约 | 旧（phase11） | 新（phase13） | 判定 |
|---|---|---|---|
| 表名泄漏 | `missingTables:[{table,…}]` | **`missingCount:0`** | 已修 |
| 运行时探测 | 无 `runtime` 字段 | **`runtime` 为一等字段并纳入 `ok`** | 已修 |
| 加密判定 | 认 `service_role_key` | **只认 `ENCRYPTION_SECRET`** | 已修 |
| 健康检查 | `exceeded timeout (5s)` | **healthy** | 已修 |

镜像重建过程中暴露了一个此前不可见的事实：**构建期 `next build` 会跑全项目 `tsc`**，
因此任何 `.mts` 脚本的类型错误都会**阻断镜像构建**。§3 的 `ts-check` 失败
不只是质量门失效，它同时是 Phase 14 "镜像重建未完成"的**根因之一**。

---

## 14. 可观测性：仍缺外部系统（未做）

任务书 #5 要求评估"能追踪但不能监控"。本轮只做评估与取证，**未引入任何外部系统**
（架构决策，且受"零新增依赖"约束）。

| 能力 | 状态 | 本轮实测 |
|---|---|---|
| request id 贯通 | 有 | `x-request-id: d02d4955-…` 在响应头可得 ✓ |
| 工具门控审计 | 有 | `/data/audit/tool_gate.jsonl`，8 行，可解析 ✓ |
| 业务审计 | 有 | `audit_events` 21 行 ✓ |
| 调度器可观测 | **无** | health 的是另一个模块实例（§10） |
| 数据库 schema 自检 | **无效** | fail-open（§4） |
| APM / 指标导出 / 告警 / 日志聚合 / 备份调度 | **无** | 未引入 |

**本轮结论：可观测性的第一道缺口不是"缺 APM"，而是已有信号不可信。**
先让 `/api/health` 说真话（§4、§10），再接采集器。

---

## 15. 未完成 / UNVERIFIED

| 项 | 状态 |
|---|---|
| 在真实库应用 `migrate-runtime-metadata.sql` | **UNVERIFIED** —— 本机无 DDL 凭据（已入自动迁移链，下一次带 DSN 的部署会创建）。已核实不存在 `exec_sql` 类 RPC，无法绕过：`migrate.sql` 只有 `claim_agent_task_runs` / `claim_notification_outbox` / `claim_daily_briefing_slot` 三个业务函数 |
| 修复 scheduler 健康可见性 | **已修** —— 见 §19（心跳落库 + health 读心跳） |
| APM / 指标导出 / 告警 / 日志聚合 / 备份调度 | **未做** —— 需引入外部系统 |
| 新注册商家的平台内置模型回落 | **已修（代码）** —— 见 §20。行为已单测覆盖；**端到端未验证**（本环境没有可用余额的 provider 密钥） |
| 测试残留 tenant/business 清理 | **计划已生成，未执行** —— 见 §21 |
| `agent_tasks` 10 行 `active` | **未查** —— 观察到未消费的任务队列，未判断是积压还是正常在途 |
| `gateway/` 死代码处置 | **未做** —— 沿用 Phase 13 结论（活跃依赖，未删） |
| P1-3 沙箱 L4 | **未做** |

---

## 16. 给下一阶段的建议（按证据排序）

| 优先级 | 事项 | 依据 |
|---|---|---|
| 1 | **部署前应用 runtime-metadata 迁移** | §5；否则审计元数据永远为空 |
| 2 | **修 scheduler 健康可见性** | §10；否则 `/api/health` 会漏报调度器死亡 |
| 3 | **清理测试残留 tenant/business 后再当基线** | §6；本轮又新增 3 条 |
| 4 | **轮换 Supabase 凭据** | 沿用 Phase 14 §5 的建议（长 JWT 曾出现在会话中） |
| 5 | **查 `Unsupported state or unable to authenticate data`** | §15；涉及已落库凭据可解密性 |
| 6 | 再考虑接 APM | §14；信号可信之后再接采集器 |
| 7 | 插件沙箱：仅在引入社区插件时才需要验证 | §9；当前候选集为空 |

---

## 17. 一句话

镜像重建完成、端到端 30/30、延迟归因清楚 —— 但本轮更有价值的部分是
**推翻了上一轮两条"通过"结论**：真实库其实更完整（51/51），
而生产自检与健康端点**不具检测能力**，调度器在跑却对健康检查不可见。

四轮下来的同一条教训再次成立：**一个不能失败的检查，等于没有检查。**

---

## 18. 追加：已落库凭据的解密失败（R-03 迁移面）—— 已修并验证

§15 曾把 `memory extraction failed: Unsupported state or unable to authenticate data`
列为"未查"。现已定位到根因、修复并验证。

### 18.1 定位过程

| 步骤 | 命令 / 脚本 | 结果 |
|---|---|---|
| 1. 找凭据列 | `scripts/_verify_column_names.mts` | **文档写的列名不存在**：三张表都没有 `credentials` |
| 2. 真实列名 | 同上（`select('*')` 取列） | `model_configs.api_key_encrypted`、`email_accounts.credentials_encrypted` |
| 3. 试解密 | `scripts/_container_decrypt_check.cjs`（**容器内跑**，密钥不出容器） | 两行密文**只能用 `sha256(COZE_SUPABASE_SERVICE_ROLE_KEY)` 解开** |
| 4. 关联调用链 | `scripts/_verify_model_assign.mts` | `model_assign.light = deepseek:deepseek-v4-flash` ⟷ `model_configs` 的 `deepseek` 行 |

即：这两行是**在 `ENCRYPTION_SECRET` 存在之前**写入的，当时 `crypto.ts` 的密钥
回落到 `COZE_SUPABASE_SERVICE_ROLE_KEY`（正是 R-03 描述的"回落不是可能，是一定"）。
Phase 12 给 `ENCRYPTION_SECRET` 赋了独立新值，于是这两行变成永久不可解 —— 除非按
`crypto.ts` 的迁移说明提供历史密钥。

### 18.2 修复过程中发现的第二个缺陷：compose 白名单

按文档设置 `ENCRYPTION_SECRET_PREVIOUS` 后**无效** —— 容器里该变量仍为空。
原因：`docker-compose.yml` 的 web 服务用**显式白名单**注入环境变量，
`docker/deploy.env` 里新加的变量不会自动进入容器。

这与 §5 的列缺失同属一类：**代码支持的能力，缺少一条把它接通的线**。
修复：在 compose 的 web 服务下显式加入 `ENCRYPTION_SECRET_PREVIOUS`。

### 18.3 修复效果（实测）

| 检查 | 修复前 | 修复后 |
|---|---|---|
| 容器内 `ENCRYPTION_SECRET_PREVIOUS` | 不存在 | 存在（len 219） |
| 两行 `model_configs` 可解密 | 否 | **是**（密钥 = `ENCRYPTION_SECRET_PREVIOUS[0]`） |
| Default tenant 的记忆沉淀错误 | `Unsupported state or unable to authenticate data` | **`deepseek 调用失败 (402): Insufficient Balance`** |

最后一行是关键证据：错误**从"解不开"变成了"provider 拒绝"**，
说明凭据已经真的被解开并送到了 DeepSeek。剩下的 402 是 **DeepSeek 账户余额不足**，
属账户状态而非代码缺陷。

### 18.4 仍未解决：新注册商家在 TS 侧的模型回落不可用

> **更正**：本节初稿写成「新注册商家的 AI 完全不可用」。该判断**过大**，
> 已由 §20.6 的实测推翻 —— Agent 对话走 RoveAgent 运行时，不受此影响。
> 以下保留修正后的准确描述。

`_verify_settings_scope.mts` 实测（8 个 tenant / 仅 1 行 settings）：

| tenant | settings 行 | 生效 `model_assign` |
|---|---|---|
| `Default` | 1 | `deepseek:deepseek-v4-flash`（四个能力） |
| 其余 7 个（含全部 E2E 新注册） | **0** | 视为 `auto` → **平台内置** |

`/api/auth/signup` 建 tenant、business、auth user、public.users，
但**不建 `settings` 行**。`resolveModelDetailed` 对 `auto` 走
`platformResolution()`，该分支**不携带 `apiKey`**，而本环境未配置平台密钥 ——
于是 **TS 侧**的 `invokeChat` 调用回
`API key is required. Set COZE_API_TOKEN or provide apiKey in config.`

**影响面**：只有 TS 侧自己发起的轻量调用（当前是 `extractAndStoreMemory()`
的 `invokeChat('light', …)`），后果是**企业长期记忆对新商家不沉淀**。
AI 对话本身走 RoveAgent 运行时，凭据是 `ROVEFRAME_LLM_API_KEY`，不受影响。

| 层面 | 判定 |
|---|---|
| 代码缺陷？ | **否** —— `auto` 回落平台内置是设计行为 |
| 产品缺口？ | **是** —— 平台回落的可用性依赖"平台密钥"，自部署场景下没有 |
| 报错质量？ | 差（**已修**，见 §20）—— 面向老板的提示不该是 SDK 原始报错 |

### 18.5 顺带修正：文档中的列名

`AGENTS.md` 与 Phase 12 报告称 `model_configs.credentials` /
`email_accounts.credentials` / `integration_configs.credentials` 为加密凭据列。
实测三张表**均无此列**；真实列名为 `api_key_encrypted` 与 `credentials_encrypted`。
`integration_configs` 的 10 列里没有任何疑似凭据列。

---

## 19. scheduler 健康可见性 —— 已修

§10 记录了问题：调度器在跑（`cron_state` 有它写的行），但 `/api/health` 报的是
**另一个模块实例**的状态，`degraded` 恒为 false。

### 19.1 修法：把"调度器是否活着"变成落库的事实

心跳写入 `cron_state` 的 `scheduler.heartbeat` 键，每 tick 一次；
`schedulerHealth()` 优先读心跳，读不到才回退到本实例变量。

这样无论有几个模块实例、状态在谁身上，health 看到的都是**真调度器写下的证据**。
不新增依赖、不新增表（复用 `cron_state`）。

### 19.2 顺带修掉一个同类的 fail-open

`cronStateReady: null` + `degraded: false` 原本会让一个**从未跑过**的调度器
看起来健康。现在 `/api/health` 额外要求：

| 条件 | 判定 |
|---|---|
| `source === 'unknown'`（没有任何 tick 留下心跳） | **不健康** |
| 心跳过期（`> 60s × 5`） | **不健康** |
| `degraded`（`cron_state` 缺失） | 不健康（原有行为） |

响应里新增 `scheduler.ok / heartbeatStale / lastTickAt / tickAgeMs / source`，
让"为什么判不健康"可读。

不会在正常启动时误报：`startScheduler()` 立即触发一次 tick，
而容器健康检查有 90s 的 `start-period` 宽限。

### 19.3 负向验证

`tests/scheduler-health-visibility.test.ts`（5 例）。注入回归
（删掉 `source !== 'unknown'` 判定）后**1 例变红**，还原后 5/5 绿。

---

## 20. 新注册商家的 AI 开箱不可用 —— 代码已修，端到端未验证

### 20.1 问题（§18.4 已取证）

`/api/auth/signup` 不建 `settings` 行 ⇒ `model_assign` 视为 `auto`
⇒ 走 `platformResolution()` ⇒ 该分支只有一个实现：`coze-coding-dev-sdk` 的
`LLMClient`，凭据是平台注入的 `COZE_API_TOKEN`。自部署 compose 从不注入它 ⇒
新商家一条消息都发不出去，报 SDK 的原始文案。

### 20.2 修法

| 变更 | 内容 |
|---|---|
| 新增可选环境变量 | `ROVEFRAME_PLATFORM_LLM_API_KEY` / `_BASE_URL` / `_MODEL`。设置后"平台内置"走**既有**的 OpenAI 兼容通路（`streamExternal`），零新增依赖 |
| base URL 安全 | 复用 `checkBaseUrl`，私网/链路本地地址**抛 `ssrf_blocked`**（配置错误必须显式报错，不静默跳过） |
| 未配置时 | 返回 `null`（候选不可用），直连路径抛 `AIError(no_provider)`，文案改为**可操作**的说明，不再透出 SDK 文案 |
| 故障切换链 | 平台不可用时记入 `skipped(not_configured)`，**不抛错** —— 链的职责是收集全部失败原因，一个候选抛错会吞掉其余 provider 的信息 |
| compose 白名单 | 三个新变量同时加入 `docker-compose.yml`（否则重犯 §18.2 的静默丢弃） |

### 20.3 过程中修正了我自己的一个设计错误

初版让 `platformResolution()` 无条件抛 `no_provider`，结果**打断了故障切换链**，
5 个既有用例变红。这暴露了分层错误：**"唯一选项"与"候选之一"不能用同一种失败语义**。
改为返回 `null`（与既有 `resolveExternalModel` 同一约定），由调用方决定跳过还是报错。

两个 failover 用例的**前提确实变了**，已就地改写并注明理由，未静默修改：

| 用例 | 原前提 | 修正后 |
|---|---|---|
| `...degrades to the platform model only` | 平台永远可用 ⇒ 恰好 1 个候选 | 平台可用则 1 个候选；不可用则 0 候选 + `skipped` 记录原因 |
| `...platform candidate is always last` | 平台候选总存在 | 显式注入 `COZE_API_TOKEN` 后再断言"它排最后" |

### 20.4 验证边界（诚实说明）

| 项 | 状态 |
|---|---|
| 行为单测（8 例，含 SSRF 拒绝与半配置） | **通过**；负向对照：还原初版抛错实现后 2 例变红 |
| `resolvePlatformModel` 三分支 | **通过** |
| 故障切换链跳过语义 | **通过** |
| 新商家的**用户可见报错**（真实 HTTP） | **通过** —— 不再透出 SDK 文案，改为可操作说明 |
| 新商家"能收到真实回复" | **通过，且与本修复无关** —— 见下 |

### 20.6 更正：我在 §18.4 把影响面说大了

<details>
<summary>原文（保留）：§18.4 曾写「新注册商家的 AI 完全不可用」</summary>

> **新注册商家的 AI 完全不可用** … 于是新商家在配置任何 provider 之前，
> AI 一律回 `API key is required. Set COZE_API_TOKEN or provide apiKey in config.`

</details>

**该结论不成立。** 实测（`scripts/_verify_newtenant_error.mts`，真实注册 + 真实 HTTP）：

| 观测 | 结果 |
|---|---|
| 新商家 chat 请求 | **HTTP 200** |
| `runtime_status` | `mode: "roveagent"` |
| 正文长度 | **1618 字符**（模型真的答了） |
| `error` / `notice` 事件 | 无 |

原因：**Agent 对话走的是 RoveAgent 运行时**，它的模型凭据是
`ROVEFRAME_LLM_API_KEY`（compose 已注入），与 TS 侧 `model_assign` /
平台内置回落是**两条独立通路**。我把"TS 侧平台回落不可用"错推成了"AI 不可用"。

**真实影响面（修正后）**：只有 TS 侧自身发起的那条轻量调用受影响 ——
即 `extractAndStoreMemory()` 的 `invokeChat('light', …)`。后果是
**企业长期记忆对新商家不沉淀**（功能降级，非不可用），且代码已把它标为
non-blocking 并捕获。

修复仍然有价值：它把一条**静默失败的功能**变成有明确原因的失败，
并给自部署运营方提供了让平台回落真正可用的开关。但它的严重度远低于我原先的描述。

### 20.5 部署方需要做的

二选一：

1. 设置 `ROVEFRAME_PLATFORM_LLM_API_KEY` + `ROVEFRAME_PLATFORM_LLM_BASE_URL`
   （见 `docker/deploy.env.example` 的说明）—— 让 TS 侧（记忆沉淀等）真正可用；**或**
2. 让每个商家在设置页接入自己的服务商。

不做也不会影响 AI 对话本身（走 Runtime）。

---

## 21. 测试残留清理计划（已生成，未执行）

`scripts/_cleanup_test_residue.mts` 默认**零写入**，只打印计划；`--apply` 才删除。

计划范围（**锚点显式排除**：tenant `000…000` / business `000…001`）：

| 对象 | 数量 | 命名 |
|---|---|---|
| tenant | 7 | `rls-probe`、`424323`、5 个 `E2E Phase15 …` |
| business | 6 | 同上（`rls-probe` 没有 business） |

引用清点（删除顺序的依据，非零引用全部列出，不静默级联）：

| tenant | 引用 |
|---|---|
| `rls-probe` | 无 |
| `424323` | businesses=1, agent_tasks=2, agent_task_runs=19 |
| 每个 `E2E Phase15 …` | businesses=1, users=1, chat_sessions=1, audit_events=3, agent_tasks=2, agent_approvals=1, agent_task_runs=3, inventory_items=1, ai_usage_ledger=1 |

删除顺序：先删 `agent_task_runs`（`agent_tasks` 的子表，按 business 逐条），
再按 `tenant_id` 删其余表（含 `businesses`），最后删 `tenants`。
顺序反了会撞外键 23503。

**未执行**：该操作不可逆，等确认。注意本轮验收又新增了 2 条（共 7 条 tenant）。
