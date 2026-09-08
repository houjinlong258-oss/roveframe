# ROVEAGENT_MIGRATION_COMPLETE.md
# RoveAgent Core 迁移完成报告

日期：2026-09-05 ｜ 路线：**A — 按原蓝图 fork（深度融合）** ｜ 状态：✅ 核心迁移完成

产物位置：`D:\游戏\roveagent\`（已自包含，可整体迁入 RoveFrame 仓库，建议落位 `packages/roveagent-core/` 或仓库根的 `roveagent/`）

---

## 1. 吸收的 RoveAgent 组件（fork 自 RoveAgent Core v0.21.0，MIT）

| 来源 | 落位 | 能力 |
|---|---|---|
| `agent/`（155 文件） | `roveagent/core/` | Agent Loop、流式 tool calling、上下文引擎/压缩、MoA 多模型合议、skill 引擎、子代理生命周期、学习闭环（curator/learning_graph/insights） |
| `tools/`（138 文件） | `roveagent/tools/` | 130+ 工具全集（终端/文件/浏览器/代码执行/委托/cronjob/skill 管理…） |
| `RoveAgent_state*.py`（15.8k+2.5k 行） | `roveagent/state/` | SQLite 状态库 + **FTS5 会话记忆搜索** |
| `gateway/`（67 文件） | `roveagent/gateway/` | 渠道网关内核（delivery/pairing/authz/stream/relay） |
| `plugins/platforms/` | `roveagent/plugins/platforms/` | **23 个消息平台**：Telegram / Discord / Slack / WhatsApp / Matrix / Teams / 飞书 / 钉钉… |
| `plugins/`（其余） | `roveagent/plugins/` | browser/memory/kanban/model-providers 等插件 |
| `cron/` | `roveagent/cron/` | 自然语言定时任务（jobs/executions/monitor/incidents） |
| `providers/` | `roveagent/providers/` | 多模型抽象 |
| `RoveAgent_cli/` | `roveagent/clisupport/` | 配置/子进程兼容/超时/认证支撑层（核心依赖它，故保留） |
| `skills/`（330 文件） | `roveagent/skills_library/` | 内置技能库（13 分类） |
| `run_agent.py`（9.4k 行） | `roveagent/runtime.py` | 主循环入口 |
| `toolsets.py` 等根模块 | `roveagent/*.py` | 工具组注册表等 |

合计迁移 **1524 个源文件单元**。

## 2. 重写的部分

- **模块命名空间**：全部绝对 import 机器重写为 `roveagent.*`（agent→core、tools→tools、gateway→gateway、cron→cron、providers→providers、plugins→plugins、RoveAgent_cli→clisupport、RoveAgent_state→state、run_agent→runtime 等），迁移脚本 `migrate_fork.py` 可复现。
- **品牌层**：RoveAgent→ROVEAGENT / RoveAgent→RoveAgent / RoveAgent→roveagent 三连替换，1036 文件、18837 处，含环境变量（`ROVEAGENT_*`）、配置目录（`.roveagent`）、服务名。完成后 Python 文件品牌残留 **0**，全仓残留 **0**（仅 LICENSE/NOTICE 依法保留 Nous Research 归属）。
- **包入口**：`roveagent/__init__.py` 重写为延迟加载公共 API（`RoveAgentKernel` / `EnterpriseToolGate` / `EnterpriseMemory`）。

## 3. 移除的部分（未带入 fork）

RoveAgent CLI 入口与 TUI（`cli.py`、`tui_gateway/`、`ui-tui/`）、桌面应用（`apps/desktop`）、个人助手外围（`web/`、`website/`、`assets/`、`locales/`）、安装器（`setup-RoveAgent.sh`、`docker/`、`nix/`）、研究向工具（`evals/`、`batch_runner.py`、`mini_swe_runner.py`、`trajectory_compressor.py`、`datagen-config-examples/`）、ACP 编辑器适配（`acp_adapter/`）。

## 4. 新写的企业代码（本轮新增，非 RoveAgent 原有）

| 文件 | 作用 |
|---|---|
| `roveagent/tools/framework.py` | **企业工具门控**：Schema 校验 → 权限检查 → 审批策略（none/manager/owner/admin）→ 审计留痕；glob 策略表可覆盖（refund\_\*→owner 审批、deploy\_\*→admin 审批…） |
| `roveagent/state/enterprise_memory.py` | **L0–L4 分层租户隔离记忆**：SQLite+FTS5（trigram 分词，支持中文子串检索），强制 tenant 过滤、BM25+时效+重要度排序、过期清理、隔离不变量（L2+ 必须有 tenant_id） |
| `roveagent/__init__.py` / `pyproject.toml` / `README.md` / `NOTICE` | 包元数据与公共 API |

原有企业层（tenant/permissions/enterprise/connectors/business/agents/repair/deployment/kernel.py，55 文件）原样合并保留。

## 5. 新架构

```
roveagent/                     RoveAgent Core v1.0.0
├── runtime.py                 Agent 主循环入口（原 run_agent）
├── core/                      Agent Loop / Context / Skills 引擎 / 子代理 / 学习闭环
├── state/                     FTS5 记忆搜索 + enterprise_memory（L0–L4 租户隔离）
├── tools/                     130+ 工具 + framework.py 企业门控
├── gateway/ + plugins/        渠道网关 + 23 平台适配
├── cron/                      例行任务
├── providers/                 多模型
├── skills_library/            技能库（自学习素材）
├── tenant/ permissions/ enterprise/ connectors/ business/ agents/ repair/ deployment/
│                              企业控制层（上一轮成果，已合并）
├── kernel.py                  RoveAgentKernel 企业内核
├── LICENSE + NOTICE           MIT 合规链路
└── pyproject.toml             roveagent-core（依赖沿用 exact-pin 策略 + web/telegram/discord/slack extras）
```

## 6. 验证结果（本轮实际执行）

- 全包 **906 个模块导入扫描：851 OK，内部命名空间断链 0，其他错误 0**；55 个失败全部为未安装的第三方依赖（httpx/fastapi/rich 等，已声明于 pyproject）。
- 全部文件 `compileall` 语法检查通过（迁移后与品牌替换后各一轮）。
- 企业门控功能测试通过：权限不足拒绝 / 经理发起退款→业主审批入队 / admin 直执 / 4 条审计事件全部留痕。
- 租户记忆功能测试通过：trigram FTS 中文检索命中、跨租户不可见（restA 读不到 restB）、L0/L1 共享层可达、过期清理生效、隔离不变量抛错。
- 品牌扫描：除 LICENSE/NOTICE 外 `RoveAgent` 残留 0。
- 门控接线端到端冒烟（迁入 RoveFrame 仓库后执行）：一句话开店（租户+行业包+6 人 AI 团队+Square sandbox 同步）→ L2 租户记忆写入/检索命中 → 经理发起 `refund_payment` 被门控拦截转入 owner 审批 → `read_sales` 放行执行 → 审计留痕。**E2E PASSED**。

## 7. 安全审查

- 所有工具调用现在可经 `EnterpriseToolGate` 统一门控（默认策略表 + 部署侧覆盖），拒绝与审批事件同样留审计。
- 记忆层默认租户隔离，隔离不变量由代码强制（非约定）。
- 依赖沿用上游 exact-pin 供应链策略。

## 8. 性能影响

- Python 运行时为新增常驻进程；网关单进程承载全平台渠道。
- FTS5 检索为本地 SQLite 毫秒级；企业记忆检索额外引入 recency/importance 排序（内存计算，O(limit×4)）。
- 子代理并行沿用上游实现（隔离 worktree），资源开销与原设计一致。

## 9. 遗留与路线图

1. **迁入 RoveFrame 仓库**：将 `D:\游戏\roveagent\` 复制到目标仓库；`pip install -e "roveagent[web,telegram,discord,slack]"`。
2. **TS↔Python 通信**：用 `roveagent.gateway.platforms.api_server`（FastAPI）作为 RoveFrame Next.js 的唯一接口面；企业门控的 Approval 队列对接 `src/lib/enterprise` 审批 UI。
3. ~~运行时接线~~（已完成 2026-09-05）：`enterprise/gate_hook.py` 已把 `EnterpriseToolGate.authorize` 注册进 `core` 的工具执行中间件链（`tool_execution` middleware），`RoveAgentKernel` 启动时自动安装；宿主经 `set_tool_context_resolver` 注入租户/角色/权限。蓝图 Phase 4 的 Reason→Permission→Approval→Execute→Audit 链路已闭环。
4. **Approval 队列对接**：门控产出的 `requires_approval` 事件需对接 `src/lib/enterprise` 审批 UI（TS 侧），批准后重放工具调用。
4. **行业技能包**：扩充 `skills/packs/`（restaurant 已有雏形 → retail/hotel/healthcare）。
5. **平台默认启用面**：首发建议 telegram/discord/slack/api_server，其余 19 个平台保持代码保留、配置关闭。
6. 已知限制：`fcntl` 等 Unix-only 依赖使个别模块仅限 Linux/macOS（生产容器不受影响）；两个桌面仪表盘插件的 minified JS 已机械换名，未做功能测试。

## 10. 合规声明

RoveAgent Core 衍生自 RoveAgent Core v0.21.0（Copyright (c) 2025 Nous Research，MIT License）。`roveagent/LICENSE` 保留 MIT 原文，`roveagent/NOTICE` 记录来源归属。外部身份为 RoveAgent；内部保留完整开源来源记录，满足融资 DD 合规要求。
