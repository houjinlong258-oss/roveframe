# Phase 1 Complete — Runtime 稳定与执行链路修复

**日期**：2026-09-12
**自主执行模式**：未逐项询问；未触碰生产数据、未删模块、未改安全模型、未用生产密钥。
**前置**：`docs/stage3.1-runtime-recovery-report.md`

---

## 完成内容

Phase 1 的目标是「Runtime 稳定 + 执行链路可用」。扫描阶段发现**三个真实缺陷**，
其中两个是「AI 不能联网搜索」「AI 不能出图」的**直接根因**，均已修复并实测。

### 1. 修复 `_wt` 未绑定 —— 联网搜索全线不可用的根因 ★

`roveagent/plugins/web/firecrawl/provider.py` 通篇用 `_wt.<name>` 访问
`tools.web_tools` 的内部符号，但**该别名从未被绑定**：

```
NameError: name '_wt' is not defined
  at provider.py:164  cfg = _wt._load_web_config()
  ← check_firecrawl_api_key() ← web_tools._is_backend_available()
  ← check_web_api_key() 遍历 _LEGACY_WEB_BACKENDS
```

**级联后果（实测）**：`check_fn` 被 registry 记为 `raised` →
`web_search` / `web_extract` 判为不可用 → 连带 `web` / `search` / `safe` /
`coding` **四个 toolset 全部不可用**。这就是「AI 不能搜索互联网」的根因。

**修复**：新增惰性取值函数 `_web_tools()`，把 18 处 `_wt.` + 2 处裸 `_wt`
改为惰性访问。**为什么不用顶层 import**：`tools/web_tools.py:52` 在模块级从本模块
导入符号，顶层互相 import 会形成循环 —— 惰性取值在首次调用时解析，
此时 `web_tools` 必然已完成初始化。

**实测对比**：

| | 修复前 | 修复后 |
|---|---|---|
| `check_web_api_key()` | `RAISED(NameError)` | **`True`** |
| `web_search` check_fn | RAISED | **PASS** |
| `web_extract` check_fn | RAISED | **PASS** |
| `web` toolset | unavailable | **AVAILABLE** |

### 2. 重建空的 `image_generation_tool.py` —— 出图能力完全缺失的根因 ★

`roveagent/tools/image_generation_tool.py` 是 **0 字节空文件**。由于
`discover_builtin_tools()` 按 AST 扫描「文件是否调用 `registry.register()`」，
空文件**永不被导入**，于是：

- `image_generate` 工具**从未注册** → 模型根本没有这个工具
- `tools_config.py:4286` 的 `from ... import FAL_MODELS, DEFAULT_MODEL` 必然失败
- `video_generation_tool.py:274` 的 `from ... import _confine_source_images` 必然失败
  —— 即**视频生成也一并被拖坏**

**修复方式（不重复造轮子）**：真正的出图后端 `plugins/image_gen/{fal,openai,
openai-codex,xai,deepinfra,krea,openrouter}/` **早已完整实现**，统一遵循
`core/image_gen_provider.ImageGenProvider`。新建的模块只做三件事：

1. 暴露 provider 插件期望导入的兼容符号
   （`FAL_MODELS` 惰性 dict / `DEFAULT_MODEL` 惰性 str / `check_fal_api_key` /
   `_resolve_fal_model`）；
2. 实现 `image_generate_tool()` —— 委托给 `get_active_provider()`
   （**不实现任何出图逻辑**）；
3. 实现 `_confine_source_images(image_url, refs, task_id) -> (img, refs, err)`
   —— 按 `video_generation_tool.py:276` 的真实契约（3 参数、返回三元组），
   并**委托** `tools/image_source.resolve_local_source_to_data_url` 完成沙箱内读取，
   延续既有的「路径必须受沙箱边界约束」安全模型（GHSA-gpxw-6wxv-w3qq），**不另立一套**。

并补上缺失的注册：

```python
registry.register(
    name="image_generate", toolset="image_gen",
    schema=IMAGE_GENERATE_SCHEMA, handler=_handle_image_generate,
    check_fn=check_image_generation_requirements, emoji="🎨",
)
```

**实测对比**：

| | 修复前 | 修复后 |
|---|---|---|
| registry 工具总数 | 99 | **100** |
| `image_generate` 已注册 | **False** | **True** |
| `image_generate` toolset 归属 | — | `image_gen` |
| `image_gen` toolset | unavailable | **AVAILABLE** |
| `video_gen` | AVAILABLE（但工具 check_fn FAIL） | AVAILABLE |

### 3. Agent Capability Router（Architecture §3）

新增 `roveagent/api/capability_router.py`。**不取代** Step 1.75 的
`api/toolsets.py`（那份最小映射依然生效、已有测试锁定），而是在其上补两层：

| 层 | 作用 |
|---|---|
| **能力解析** | toolset → 实际工具名集合。取「`toolsets.py` 的 `tools` 声明」∪「registry 的 `get_toolset_for_tool()` 归属」∪「`includes` 递归展开」，并做环检测 |
| **漂移/可用性报告** | 明确指出①哪些 toolset 名**没有任何已注册工具**（声明漂移）②哪些工具因 `check_fn` 未通过而**当前不可用**（缺凭据） |

**为什么需要它（两个真实故障逼出来的）**：

- `process` **不是** toolset —— registry 里它归属 `terminal`
- `search` 是**声明漂移** —— `TOOLSETS["search"]` 声明 `web_search`，
  但 registry 里 `web_search` 归属 `web`，于是 `search` 没有任何已注册工具，
  **实测不出现在 `get_available_toolsets()` 里**。若某 agent 只映射 `search`，
  它会**静默拿不到任何工具**且调用方看不到任何错误。

**能力画像**（新增 5 个能力位，全部遵守「不新增工具」—— 只按职责重组已有工具）：

| Agent | toolsets | 迭代预算 |
|---|---|---|
| CEO | `safe` `memory` `business` `search` | 8 |
| operations | `safe` `memory` `business` | 8 |
| CMO（marketing） | `safe` `memory` `business` `search` `web` `media` `social` | 8 |
| Developer | `file` `terminal` `todo` `git` `skills` `delegation` | 16 |
| DevOps | `terminal` `docker_read` `monitoring` `todo` | 16 |

新增 toolset 定义（`toolsets.py`）：`git` / `docker_read` / `monitoring`
（三者 `includes: ["terminal"]`，因为 registry 里没有独立 git/docker/monitoring 工具）、
`media`（组合 `image_gen`+`video_gen`+`tts`+`vision`）、
`social`（组合 `web`+`x_search`；**无内置社交发布工具**，如实声明）。

---

## 修改文件

| # | 文件 | 动作 |
|---|---|---|
| 1 | `roveagent/plugins/web/firecrawl/provider.py` | 修复 `_wt` 未绑定（+48 行惰性访问器） |
| 2 | `roveagent/tools/image_generation_tool.py` | **从 0 字节重建**（~460 行，含注册） |
| 3 | `roveagent/api/capability_router.py` | **新建** |
| 4 | `roveagent/api/capability_router_test.py` | **新建**（19 测试 / 64 子测试） |
| 5 | `roveagent/toolsets.py` | 新增 5 个能力位 toolset 定义 |

**未修改**：`runtime.py`、`EnterpriseToolGate`、`PermissionEngine`、
`api/toolsets.py`（Step 1.75 那份）、任何既有 provider 插件实现。

---

## 架构变化

```
                 RoveFrame AI OS
                       UI
                       |
               Agent Gateway              ← src/app/api/agent/chat (SSE)
                       |
          Agent Capability Router         ← 【本阶段新增】capability_router.py
                       |                    能力画像 + 漂移/可用性报告
               RoveAgent Runtime           ← runtime.py（未改动）
                       |
          ---------------------
          |        |          |
       Tools    MCP       Plugins         ← 100 个已注册工具（+image_generate）
          |
    EnterpriseToolGate                    ← 唯一执行门（未改动）
          |
      Approval System
          |
     Sandbox Execution                    ← tools/environments/*
```

关键变化：**能力解析显式化**。此前「agent 该有哪些工具」是一张硬编码映射表且
失败静默；现在有解析器 + 诊断报告，能回答「为什么这个 agent 少工具」。

**职责边界（保持）**：Capability Router 只决定「把哪些工具**递到模型面前**」；
工具**能否执行**仍由 `EnterpriseToolGate` 独立裁决。两层是**与**关系。

---

## 测试结果

```
$ python -m pytest roveagent/api roveagent/tools/permissions_policy_test.py -q
88 passed, 136 subtests passed in 10.62s

$ pnpm exec tsx --test tests/runtime-*.test.ts
ℹ tests 36  pass 36  fail 0

$ pnpm exec tsc -p tsconfig.json --noEmit
exit 0
```

`capability_router_test.py` 覆盖：未知 agent fail-closed、大小写/空白不敏感、
预算上限、开发者拿到 file+terminal、CEO 不含 file+terminal、
**能力画像引用的每个 toolset 名都真实存在**、
`terminal` 解析含 `process`、`git` 意图经 terminal 满足、
**`search` 漂移被检出**、纯组合 toolset 通过 includes 解析、
报告记录全部 agent、`unavailable_toolsets` 被暴露、
以及**与 `api/toolsets.py` 的一致性**（Phase 1 必须是 Step 1.75 的超集，
迭代预算必须一致）。

---

## 当前剩余风险

| # | 风险 | 说明 | 处置建议 |
|---|---|---|---|
| **R1 ★** | **组合 toolset 可用性门控过严** | 实测 `safe` / `media` / `coding` / `search` / `git` / `docker_read` / `monitoring` 全部 `unavailable`，尽管其子项 `web` / `file` / `terminal` / `image_gen` 已 AVAILABLE。`get_available_toolsets()` 对组合 toolset 采用「任一子项不可用即整体不可用」语义 → **agent 会被静默少给工具**。这是下一阶段最该修的项 | Phase 2 首要任务：给 `resolve_toolsets` 加可用性感知，按子项逐个过滤并记录缺失原因 |
| R2 | `video_generate` 工具级 check_fn 仍 FAIL | toolset 显示 AVAILABLE 但工具本身不可用（内部不一致）。需要 xAI/fal 视频凭据 | 配置凭据后复测；或让 toolset 判定与工具 `check_fn` 对齐 |
| R3 | `tts` / `vision` 工具级 check_fn FAIL | 同 R2，缺凭据 | 配置后复测 |
| R4 | `social` 无内置发布工具 | 如实声明为「组合 web + x_search」。真正的社交发布需平台适配器 + 应用审核 | Phase 5：先跑通一个平台（建议微信公众号，已有 `weixin.py` 基础） |
| R5 | `git` / `docker_read` / `monitoring` 是**已声明但无独立工具**的能力位 | 三者的实际执行都经 `terminal`。Capability Router 会把它们标为 `drift` | 属有意设计（不新增工具）；若产品需要真正的 git/docker 专用工具，需单独立项 |
| R6 | `image_generate` 字段名来自 provider 实现，未经真实上游验证 | 本机无任何图片 provider 凭据，`check_image_generation_requirements()` 返回 False | 接入一个 provider（如 FAL/OpenAI）后做真实出图验证 |
| R7 | Session runtime 元数据迁移仍未应用 | `scripts/migrate-runtime-metadata.sql`（5 列，幂等）需在有 DB 凭据的环境执行 | 应用后 Stage 2 的审计能力才完整 |
| R8 | TS→浏览器链路仍未经运行时验证 | 前端侧依旧只有 `tsc` + 源码护栏 | 提供 `.env` 后做一次端到端确认 |
| R9 | 仓库既有失败测试（3 TS + 4 Python 收集错误） | 与本次改动无关（已核实：`deploy.env` 占位、第三方 `skills_library`） | 建议清理，否则 CI 长期红会掩盖真实回归 |

---

## 下一步（Phase 2 计划）

按依赖顺序，**优先修 R1**（组合 toolset 可用性），因为它是「Phase 1 修好的能力
为何仍然递不到模型」的直接阻塞：

1. **Phase 2a**：可用性感知的 toolset 解析 —— 让 `developer` 真的拿到 `file`+`terminal`
   （当前 `git`/`docker_read`/`monitoring` 缺席会把组合 toolset 拖成不可用）
2. **Phase 2b**：Developer Agent 真实执行闭环 —— 读→改→patch→审批→写→跑测试→提交，
   并用 Mock LLM 走一遍真实文件变更验证
3. **Phase 2c**：DevOps Agent 只读巡检 + 生产变更审批
4. **Phase 3**：Plugin Center（读 `plugin.yaml`）+ 沙箱隔离（复用既有 sandbox 后端与 MCP 边界）
5. **Phase 4**：Media Hub 统一接口 + 中文 PDF 字体（`public/fonts/` 投 Noto Sans CJK）
6. **Phase 5**：Social automation 单平台闭环

将继续按此顺序自主推进，完成一个阶段输出一次报告。
