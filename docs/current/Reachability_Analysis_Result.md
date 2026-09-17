# Reachability Analysis — Result and Why It Does Not Authorize Deletion

Phase 13（只读分析）。结论：**工具已建成并通过部分阳性对照，但暴露出一个已证实的假阴性，
因此不足以授权删除任何代码。本轮未删除任何内容。**

---

## 1. 做了什么

`scripts/reachability.py` —— AST 解析 `roveagent/**/*.py` 的**全部**导入
（`ast.walk` 覆盖函数体内部的惰性导入），解析相对导入，从 11 个生产入口做 BFS。

刻意保守：每条边按**最宽候选集**展开（`from . import x` 同时算作指向包与子模块 `x`）。
多算边只会让模块被判"可达"从而不被删；少算边会导致误删。两种错误代价不对称。

入口：`api.app`（FastAPI 运行时）、`clisupport.main`（CLI）、`cron.scheduler`、
`gateway.run`（独立网关）、`kernel`、`runtime`、`bootstrap`、`model_tools`、
`toolsets`、`tools.registry`、`clisupport.container_boot`。

## 2. 结果

| 指标 | 值 |
|---|---|
| 扫描模块 | 1,189 |
| 生产入口可达 | 828 |
| 不可达 | 361 |
| 其中仅被测试引用 | 12 |
| 完全无人引用 | 349 |
| 不可达总行数 | 170,114 |

按顶层包分组（不可达）：

| 包 | 模块 | 行 |
|---|---|---|
| `roveagent.plugins` | 171 | 101,094 |
| `roveagent.clisupport` | 25 | 26,278 |
| `roveagent.skills_library` | 65 | 11,558 |
| `roveagent.tools` | 27 | 7,796 |
| `roveagent.api` | 18 | 6,343 |
| `roveagent.gateway` | 8 | 5,103 |
| `roveagent.core` | 14 | 4,863 |
| 其余 | ~33 | ~7,000 |

**对 Phase 13 原始计划的意义**：`gateway/` 只有 **8 个模块 / 5,103 行**不可达，
而它在审计清单里被标为"约 40,000 行死代码"。100 个 gateway 模块是可达的。
这独立复现了 `Dead_Code_Deletion_Stop_Report.md` 的结论。

## 3. 阳性对照：部分通过

| 探针 | 期望 | 实测 |
|---|---|---|
| `gateway.session_context` | 可达 | ✅ |
| `gateway.run` / `config` / `status` / `platforms.base` | 可达 | ✅ |
| `core.agent_init` | 可达 | ✅ |
| `cron.scheduler` | 可达 | ✅ |
| `api.app` | 可达 | ✅ |
| **`tools.business_data_tool`** | **可达** | **❌ 判为不可达** |

## 4. 假阴性：`tools/business_data_tool.py`

该模块**在静态图中只被测试文件引用**：

```
roveagent/business/data_layer_test.py:19
roveagent/business/knowledge_bridge_test.py:171,183,197
roveagent/enterprise/recovery_campaign_test.py:25
scripts/_probe_knowledge_bridge.py:50,186
roveagent/toolsets.py:89   ← 这是 Phase 12 我加的注释，不是导入
```

但它在**生产中确实是活的**，有两条独立证据：

1. Phase 12 / F-C1 排查时，容器内 `resolve_toolsets_for_request("ceo")` 返回
   `read_sales`/`read_orders`/… 共 10 个 business 工具，且
   `get_tool_definitions` 实际解析出 13 个工具；
2. 同一次排查中，ceo 的工具调用在 `tool_gate.jsonl` 留下 **7 条**审计，
   工具名为 `read_sales`。

即：一个静态图判为"无人引用"的模块，在运行时被真实加载并驱动了真实工具调用。

`tools/__init__.py` 的文档说明了这个架构的取向：

> Keep package import side effects minimal. … Callers should import concrete
> submodules directly.

也就是说，工具模块由**注册表/发现机制按需加载**，静态 `import` 语句不是它们唯一的
（在本例中甚至不是任何一条）装载路径。

## 5. 为什么这足以否决删除授权

可达性分析的用途是**判定"没人用"**。它在这一项上给出了错误答案。

只要存在一个假阴性，就不能用它的输出作为删除依据 —— 因为无法从清单本身分辨
哪些"不可达"是真死代码、哪些是动态装载。301 个"完全无人引用"的模块里，
有多少像 `business_data_tool` 一样是被注册表加载的，**当前无法确定**。

这类架构（工具注册表、平台适配器注册表、插件发现）天然大量使用动态装载，
静态导入图在这里是**结构性不足**，不是可以靠调参修好的精度问题。

## 6. 修正后的交付物定位

`scripts/reachability.py` 保留，但**定位下调**：

- ✅ 可用于**缩小排查范围**：把 1,189 个模块收窄到 361 个候选；
- ✅ 可用于**反驳**"某模块是死代码"的粗疏结论（本例即反驳了 gateway 的 4 万行判定）；
- ❌ **不可用于授权删除**。

要让它具备删除授权资格，需要补上动态装载的边，至少包括：
注册表注册点、`importlib.import_module` 的字符串实参、
`pkgutil`/`glob` 驱动的模块发现、以及 `plugin.yaml` / `toolsets.py`
这类声明式清单里出现的模块名。这是一轮独立工作。

## 7. 本轮的实际产出

| 项 | 结果 |
|---|---|
| 删除的代码 | **0 行** |
| 新增 | `scripts/reachability.py`（只读分析工具，定位为"缩范围"而非"授权删除"） |
| 更正 | `gateway/` 4 万行死代码的判定被第二次独立反驳（8 模块 / 5,103 行才是候选） |
| 否定 | AST 静态可达性分析在本仓库**不足以授权删除**，附可复现的假阴性证据 |

## 8. 一句话

工具做出来了、阳性对照跑过了、假阴性找到了 —— 于是**没有删任何东西**。
在一个大量使用动态装载的代码库里，静态可达性只能缩小范围，不能给出删除许可。
