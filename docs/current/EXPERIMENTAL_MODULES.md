# EXPERIMENTAL MODULES — Threat Model & Enablement Gates

> 本文件登记 RoveFrame 中「实验/未接线」子系统的威胁模型与启用门槛。
> 任何模块从「死代码/演示态」转为「接线生产」前，必须先完成本文件列出的前置条件。

## 1. Python SelfHealingEngine（roveagent/repair/healing.py）

- **状态**：仅被 `roveagent/kernel.py` 构造（`kernel.healing`），**无任何 API/任务路径调用** `deploy/rollback/sandbox_test`。TS 侧自愈闭环（`src/lib/healing/*` → `/api/healing`）只做采集/分析/提案，永不应用补丁。
- **威胁**（P0-13 已治理）：
  - 原 `rollback` 存在「快速通道自批」（`permissions.approve(...)`）→ 已移除，回滚与部署一样要求真实人工批准；
  - 原 git 命令 `shell=True` 拼接（提交信息可注入）→ 已改为参数列表执行 + `safe_commit_message` 净化 + commit_hash 白名单校验；
  - 沙箱测试命令改为 `shlex` 拆分参数列表执行。
- **启用门槛**（接线前必须全部满足）：
  1. 补丁应用必须复用 RoveFrame `agent_approvals` 审批链（冻结 diff + 哈希），不允许 Python 侧自批；
  2. `apply_patch/rollback` 审批必须由商户 owner 在 TS 审批 UI 完成；
  3. git 操作保持参数列表形式；commit 信息与哈希保持白名单校验；
  4. 多租户共享仓库部署下禁止启用（与 coding-agent 门一致）。

## 2. Python RoveAgentInstaller（roveagent/deployment/installer.py）

- **状态**：仅被 `roveagent/kernel.py` 构造（`kernel.installer`），**无任何 API/任务路径调用** `run(..., dry_run=False)`。
- **威胁**（P0-13 已治理）：
  - 原 `host/app_dir/ssh_user/domain` 未校验直接拼 `ssh {target} '...'`（命令注入）→ 已加白名单校验（fail-closed），非法输入拒绝生成计划；
  - 原硬编码 `POSTGRES_PASSWORD=roveframe` → 已改为每计划独立随机口令（`secrets.token_urlsafe`），仅存于本机状态文件。
- **启用门槛**：
  1. 非 dry-run 执行前必须经 RoveFrame 审批 UI 真实人工批准；
  2. 目标主机地址/凭据由平台管理员配置，禁止从商户请求透传；
  3. SSH 凭据不得入审计载荷/日志；口令轮换需重生成计划。

## 3. TS Coding Agent（src/lib/coding-agent/*）

- **状态**：`apply-engine` 具备 worktree 隔离 + 测试门禁自动 revert；`POST /api/coding-agent/apply` 为 owner 权限。
- **威胁**（P1-28）：多租户共享部署下任一租户 owner 可合入平台共享仓库；每次 apply 占用全局测试资源（无全局锁/限流）。
- **启用门槛**（生产多租户前必须满足）：
  1. 仅单租户/演示实例启用（显式环境变量门 `RF_CODING_AGENT_ENABLED` + `applyEngineAvailable` 环境检查）；
  2. 全局串行队列 + 每租户频率限制；
  3. 修改已导入文件（`src/custom/` 等）的提案强制人工 diff 确认；
  4. 平台共享仓库部署下默认关闭。

## 4. 限流（src/lib/rate-limit.ts）

- **状态**：已接线（P0-1）；进程内单实例实现。
- **部署契约**：多实例部署时每实例独立计数（限额随实例数成倍放宽）——横向扩容前必须替换为共享后端（Redis 等），保持 `checkFixedWindow/acquireSlot/noteFailure` 接口。

## 治理原则

1. 实验模块默认关闭；启用必须显式环境变量 + 本文件登记；
2. 安全敏感动作（部署/补丁/回滚）永远不能自批；审批只能来自真实人工；
3. 所有命令拼接必须先过白名单校验；shell 执行优先参数列表；
4. 新增模块如有「快速通道/自动批准/硬编码口令」原语，直接拒绝合入。
