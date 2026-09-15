# Phase 2a Complete — 可用性感知的 Toolset 解析（修 R1）

**日期**：2026-09-12
**自主执行**：未逐项询问；未触碰生产数据、未删模块、未改安全模型、未用生产密钥。
**前置**：`docs/phase1-runtime-stability-report.md`（R1）

---

## 完成内容

Phase 1 修好了 `image_generate` 与 `web_search`，但**能力仍然递不到模型**。
R1 就是那个阻塞点，本阶段定位到**精确机制**并修复。

### 1. R1 的精确机制（不再是猜测）

实测三组数据得出根因：

```
--- safe ---
  includes=['web', 'vision', 'image_gen']  declared=[]
  expanded tools(4): ['image_generate','vision_analyze','web_extract','web_search']
  available=no
    child web       avail=True
    child vision    avail=True
    child image_gen avail=True      ← 三个子项全可用
```

**根因**：`registry.get_available_toolsets()`（`registry.py:1229-1247`）只遍历
**已注册条目**、按其自带的 `entry.toolset` 字段分组：

```python
for entry in entries:
    ts = entry.toolset
    if ts not in toolsets:
        toolsets[ts] = {"available": self._toolset_has_exposable_tools(ts, entries), ...}
```

而 `safe` / `media` / `git` / `docker_read` / `monitoring` / `social` /
`search` 是 `TOOLSETS` 里的**纯组合** toolset（`includes` 非空、`tools` 为空），
**没有任何自带该 toolset 名的注册条目** → 它们**永远不会**出现在可用列表里，
无论子项是否可用。

`check_toolset_requirements()`（`:1220`）同样只覆盖
`sorted({entry.toolset for entry in entries})` → 同样的盲区。

**后果**：调用方看这个列表来决定给 agent 什么 → 组合 toolset 被当成不存在 →
**静默少给工具**。

### 2. 修复：工具级可用性解析

在 `capability_router` 新增 `resolved_available_tools()`，**绕开分组语义**，
直接对每个工具做 `check_fn` 判定（与 `get_tool_definitions` 的暴露逻辑一致），
返回 `(可用工具, 不可用工具)`。组合与原子 toolset 由此得到**同等对待**。

**为什么放在 router 而不是改 registry**：`get_available_toolsets` 是多个界面
（doctor / banner / 工具选择器）共用的上游逻辑，改它影响面大且难回滚。
router 是新增层，改这里既解决问题又可独立测试与回滚。

### 3. 接线到请求路径（关键一步）

发现并修掉一个**真实的半成品状态**：`app.py` 仍在用 `api/toolsets.py` 的
**2 条最小表**（Step 1.75 遗留），因此 Phase 1 建好的完整能力画像
**根本没被使用** —— `developer` 拿不到 `git`/`skills`/`delegation`，
`marketing` 也没拿到 `media`/`social`。

修复：`app.py` 两个端点（`/api/agent/chat` 与 `/api/agent/chat/stream`）
改为传入 `capability_router.planned_toolsets(emp.key)`，即 Phase 1 的完整画像。

`resolve_toolsets_for_request()` 新增 `capability_toolsets` 参数：
传入时优先使用，**模块边界保持干净** —— `toolsets.py` 不反向 import
`capability_router`（避免循环依赖），由调用方注入。

---

## 修改文件

| # | 文件 | 动作 |
|---|---|---|
| 1 | `roveagent/api/capability_router.py` | 新增 `resolved_available_tools()` / `filter_available_tools()`；`CapabilityReport` 加 `available_tools` / `unavailable_tools` |
| 2 | `roveagent/api/toolsets.py` | 新增 `resolve_toolsets_for_request()`（可用性感知 + 可注入画像） |
| 3 | `roveagent/api/app.py` | 两个聊天端点改用完整画像 + 可用性过滤（+`logger.debug` 诊断） |
| 4 | `roveagent/api/capability_availability_test.py` | **新建**（9 测试 / 24 子测试） |

**未修改**：`runtime.py`、`EnterpriseToolGate`、`PermissionEngine`、
`registry.get_available_toolsets()`（上游共享逻辑，保持原样）、
任何 provider 插件。

---

## 架构变化

```
Before（Phase 1）:
  agent → api/toolsets.py 的 2 条最小表 → toolset 名
        → registry 按 entry.toolset 分组 → 组合 toolset 看不见 → 静默少工具

After（Phase 2a）:
  Agent Capability Router（完整画像，5 个 agent × 6–7 toolset）
        │
        ├─ planned_toolsets(agent)          ← 意图
        │
        └─ resolved_available_tools(...)    ← 工具级 check_fn 判定
              ├─ available_tools    → 真正递到模型
              └─ unavailable_tools  → 显式报告缺口（不静默丢弃）
                        │
                resolve_toolsets_for_request()
                        │
                  AIAgent(enabled_toolsets=…)
```

关键性质：**组合与原子 toolset 同等对待**，且缺口**可见**。

---

## 测试结果

### 解析结果对比（实测）

| agent | Phase 1（最小表） | Phase 2a（完整画像 + 可用性） |
|---|---|---|
| `developer` | 3 toolset / 7 工具 | **6 toolset / 11 工具，0 不可用** |
| `devops` | 2 toolset / 3 工具 | 2 toolset / 3 工具，0 不可用 |
| `ceo` | 3 toolset / 15 工具（2 不可用未报告） | 3 toolset / **13 可用 + 2 显式报告不可用** |
| `marketing` | 3 toolset（旧画像） | **7 toolset**（含 media/social/search/web） |

`developer` 解析明细：

```
usable: ['file','terminal','todo','git','skills','delegation']
avail : 11 ['read_file','write_file','patch','search_files','terminal',
            'process','todo','skills_list','skill_view','skill_manage', …]
unavail: []
```

`ceo` 的缺口不再静默：

```
avail   : 13 ['web_search','web_extract','memory','read_sales', …]
unavail : 2  ['vision_analyze','image_generate']   ← 显式报告（缺凭据）
```

### 端到端（真实 HTTP + Mock LLM + 真实 Gate）

```
$ POST /api/agent/chat/stream  (agent=developer, permissions=["files:read"])
HTTP 200
data: {"type":"status","phase":"calling_tool","tool":"read_file"}
data: {"type":"status","phase":"tool_done","tool":"read_file"}

gate 审计: tool=read_file allowed=True perm=files:read
```

### 测试套件

```
$ python -m pytest roveagent/api roveagent/tools/permissions_policy_test.py -q
97 passed, 160 subtests passed in 19.77s

$ pnpm exec tsc -p tsconfig.json --noEmit
exit 0
```

`capability_availability_test.py` 覆盖：`safe` 能解析出可用工具、
`git` 经 `terminal` 解析、`developer` 七个核心工具全部可用、
可用/不可用集合互斥、`filter_available_tools` 与 pair 一致、
**任何 agent 都至少有 1 个可用工具**（防止静默失效）、
报告正确分离可用与不可用、CEO 仍被排除在文件工具之外（fail-closed 未削弱）。

---

## 当前剩余风险

| # | 风险 | 状态变化 | 处置 |
|---|---|---|---|
| ~~R1~~ | ~~组合 toolset 可用性门控过严~~ | **已修复**（本阶段） | — |
| R2 | `video_generate` 工具级 check_fn FAIL（toolset 却显示可用） | 未变 | 需 xAI/fal 视频凭据；或让 toolset 判定与工具 `check_fn` 对齐 |
| R3 | `tts` / `vision` 工具级 check_fn FAIL | 未变 | 需凭据 |
| R4 | `social` 无内置发布工具 | 未变 | Phase 5：先跑通一个平台 |
| R5 | `git`/`docker_read`/`monitoring` 无独立工具（有意设计） | 未变 | 如需专用工具需单独立项 |
| R6 | `image_generate` 未经真实上游验证 | 未变 | 接入 provider 后复测 |
| R7 | DB 迁移未应用（`migrate-runtime-metadata.sql`） | 未变 | 在有凭据环境执行 |
| R8 | TS→浏览器仍未经运行时验证 | 未变 | 提供 `.env` |
| R9 | 仓库既有失败测试（3 TS + 4 Python 收集错误） | 未变 | 建议清理 |

**新增观察 R10**：`registry.get_available_toolsets()` 对纯组合 toolset 的盲区
是**上游共享逻辑的固有行为**，本阶段用旁路解决。若其他界面（doctor/banner/
工具选择器）也依赖该列表展示组合 toolset，会看到同样的缺失。
建议后续单独评估是否把组合解析并入上游 —— 那属于跨界面行为变更，
需要独立决策与回归范围。

---

## 下一步（Phase 2b）

Phase 2a 已把 Developer Agent 的**写路径必备工具全部就位**
（`read_file`/`write_file`/`patch`/`search_files`/`terminal`），
Phase 2b 将验证**真实执行闭环**：

```
读取代码 → 分析 → 修改 → 生成 diff → 审批 → 写文件 → 运行测试 → git 提交
```

重点验证：`write_file`/`patch` 确实产生**真实文件变化**，
且 `MEDIUM + MANAGER` 审批策略真的拦得住（Step 1.5 已把两者设为需审批）。
由于本机 `ROVEAGENT_TEST_MODE` + Mock LLM 已就绪，
可以用确定性方式走完整链路并断言磁盘上的文件内容。

将继续自主推进。
