# 技能联网获取（#4）— 设计

状态：**设计已定，实现未开始**。三个开放问题已由产品负责人决定，记录在 §1。

动机：Agent 已经有联网搜索能力（实测 `web_search` / `web_extract` 在
ceo / operations / marketing 的 17 个可用工具里），却**装不了**它搜到的东西 ——
技能安装被刻意限制为「只能从本地目录」（`skills_market/installer.py:25-30`）。
本设计补上"落地"这一步，同时不拆掉那条刻意设置的供应链防线。

---

## 1. 已决定的三个问题

| 问题 | 决定 | 与建议的差异（如实记录） |
|---|---|---|
| 取回范围 | **任意 git 主机**（不设主机白名单） | 与设计初稿建议的「主机白名单，默认空 = 全拒」相反。风险差量见 §6 |
| 审批粒度 | **只在技能申请的 capability 超过阈值时审批** | 与初稿的「每次安装都要人批」不同；阈值直接复用现成的 `HIGH_IMPACT`（§3） |
| 谁能用 | **所有持 `skills` toolset 的 persona** | 与初稿一致。实测持有者：ceo / operations / marketing / developer / devops |

---

## 2. 架构：两阶段，网络与安装永不同处一室

**不**给 `installer.py` 加网络。新增一个只负责取回的组件，安装仍走原来那条无网络的路径。
这样 `installer.py` 的 `No network` 不变量原样保留 —— 新能力是加法，不是对它安全模型的削弱。

| 阶段 | 入口 | 产物 | 能否被 Agent 自动触发 |
|---|---|---|---|
| **1. Fetch**（不可信区） | `skill_manage(action="fetch", source=…)` | `<ROVEAGENT_HOME>/skill-quarantine/<digest>/` + `provenance.json`（url / commit sha / 时间 / 树 digest） | 可以（但只是落地，未生效） |
| **2. Install**（受控区） | `skill_manage(action="install", source=<隔离目录>)` | 技能库内的技能 | 视 §3 阈值：低影响自动，高影响需人批 |

**为什么必须两阶段**：单步「从 URL 直接安装」会重新打开 `installer.py` 已经封掉的
TOCTOU 窗口 —— 其文档原文：

> Scanning the source and then copying it leaves a window where the source can
> change. Staging first, then re-verifying the staged copy against the digest
> recorded during the scan, means the artefact that lands is provably the one
> that was reviewed.

两阶段让扫描作用在**已冻结**的产物上；`provenance.json` 里的 digest 在安装时复核，
不一致即拒。

---

## 3. 审批阈值：直接复用 `HIGH_IMPACT`，不新造分级

`roveagent/skills_market/permissions.py` 里已经有现成机制：

```python
#: Capabilities that let a skill change the machine or exfiltrate. Installing one
#: with any of these is a decision the operator has to make explicitly; the
#: installer refuses to guess.
HIGH_IMPACT: frozenset[Capability] = frozenset({          # permissions.py:77-83
    Capability.FILES_WRITE,
    Capability.SHELL_EXECUTE,
    Capability.NETWORK_EGRESS,
    Capability.ENV_SECRETS,
    Capability.PROCESS_CONTROL,
})
```

`Capability` 共 7 个成员（`permissions.py:54-69`），其中 `FILES_READ` 与
`SKILL_INVOKE` **不在** `HIGH_IMPACT` 里。

判定用的现成 API：`PermissionDecision.grants_high_impact`（`permissions.py:107-108`）、
`summarise_risk()`（`permissions.py:234-240`）。

于是阈值策略为：

| 技能申请的 capability | 行为 |
|---|---|
| 与 `HIGH_IMPACT` **无交集**（空 / 仅 `FILES_READ` / 仅 `SKILL_INVOKE`） | **自动安装**，记审计事件 |
| 与 `HIGH_IMPACT` **有交集** | **挂起，需人工审批**；审批卡片必须列出具体是哪几个高影响能力（人要看的是这个） |
| 扫描器报 `Severity.BLOCKING`（= `HIGH` 或 `CRITICAL`，`scanner.py:72`） | **一律拒绝**，审批也不能放行 |

### 三条 fail-closed 细则

1. **能力取「声明 ∪ 推断」**：`capabilities_from_content()`（`permissions.py:49`）能从内容
   推断能力。判定必须用并集 —— 否则技能只要少声明就能绕过阈值。
2. **未知/无法解析的能力按高影响处理**，即需要审批。宁可多问一次。
3. **`PROCESS_CONTROL` / `ENV_SECRETS` 即使被授予，也不可自动启用**：安装 ≠ 激活，
   激活始终是人的动作。

---

## 4. Fetch 阶段的硬限制

因为取回范围放宽到任意 git 主机，**由这些限制承担补偿控制**：

| 项 | 规则 |
|---|---|
| 协议 | 仅 `https://` 与 `ssh://git@`；拒 `file://`、本地路径、`http://`（那些是人工安装路径，不由 Agent 触发） |
| 复用解析 | 用现成的 `clisupport/plugins_cmd._resolve_git_url()`（已支持 `owner/repo`、GitHub tree URL、`ssh`、`#path`），**不重写** |
| clone 方式 | `--depth 1 --no-tags --single-branch --quiet`。**不用** `--filter=blob:none`：它让 checkout 阶段按需拉取 blob，既把网络访问拖到「已通过体积检查」之后，也让体积核算失真 |
| 体积上限 | 走目录树时**边算边判**（默认 32 MB），超限立即中止而不必先量完；`.git` **计入**上限 —— `--depth 1` 限制的是历史不是单个提交的大小，一次巨型提交的 packfile 照样落盘 |
| 路径归一 | 文件清单用 `as_posix()` 归一：digest 与 provenance 必须在 Windows 与 Linux 容器里一致 |
| 时间上限 | 子进程超时即杀并清理 |
| 隔离目录 | 安装路径**永不**读取它；只有 `install` action 把某个子目录显式传给 `install_from_directory` |
| 来源记录 | 写 `provenance.json`；复用已有的 `tools/skill_provenance.py` |
| 审计 | fetch 与 install 各发一条审计事件，走现有 mutation-guard 通道 |

---

## 5. 谁能用 + 测试计划

**给谁**：新增的两个 action 落在 `skills` toolset 里，于是**自动**覆盖所有已持有它的
persona。实测（复刻 `api/app.py:525` 的调用）：ceo / operations / marketing 各 17 个可用
工具含 `skills_list` / `skill_view` / `skill_manage`；developer 11 个；devops 亦持有。

**测试（每条都能失败）**

| 用例 | 期望 |
|---|---|
| 非白名单协议（`file://`、本地路径） | 拒，且**未创建**隔离目录 |
| 体积超限的仓库 | 拒，且隔离目录被清理 |
| 含 `rm -rf` 的仓库 | install 阶段拒（现成 fixture：`subagent-driven-development` 曾因 CRITICAL `destructive_command` 被拒） |
| 含 `you are now a` 的 `SKILL.md` | install 阶段拒（`scanner.py:149` HIGH） |
| fetch 与 install 之间篡改文件 | digest 不符 → 拒 |
| 技能少声明、内容里却用高影响能力 | 仍要求审批（声明 ∪ 推断） |
| 只申请 `FILES_READ` | 自动安装，且**不产生**审批请求 |
| 无审批的 Agent 发起高影响 install | 技能库**零变更** |
| `installer.py` 仍不含 `http` / `subprocess` / `git` | 通过（防止新能力渗进不该在的地方） |

---

## 6. 风险：这个决定买到了什么、代价是什么

**「任意 git 主机」的代价（如实记录）**：主机白名单是唯一能挡住「把技能托管在
攻击者自有域名」的机制。去掉它之后，防线只剩下 §4 的协议/体积/超时限制、§3 的能力
阈值、以及扫描器。**扫描器是模式匹配，绕过它并非难事**（换一种措辞、base64、把恶意
指令拆成多段）。因此本决定的实际含义是：**低影响技能可以来自任何主机**。

**仍未消除的风险**：

- 一个通过扫描的技能依然是一段**给 LLM 的指令**。扫描器已覆盖 prompt injection 的
  常见形态（见下），但覆盖 ≠ 完备。
- 现有缓解：内容由 `skill_view` 当**数据**读取；能力门控；所有实际动作仍受
  `EnterpriseToolGate` 独立裁决（`api/capability_router.py:29-30` 明确二者分离）。
  这些降低影响面，但不等于风险归零。
- 第三方技能需要**许可与署名**落盘 —— 与 `roveagent/NOTICE` 里 vendored skills 的处理一致。

---

## 7. 实现清单（下一步）

| # | 文件 | 内容 |
|---|---|---|
| 1 | `roveagent/skills_market/fetcher.py`（新） | 只做取回：协议校验、clone、硬限制、`provenance.json`。**可完全离线单测**（拒用路径不需要网络） |
| 2 | `roveagent/tools/skill_manager_tool.py` | 新增 `fetch` / `install` 两个 action + action 白名单更新 |
| 3 | 审批接线 | 高影响 install 走人工审批（`tools/write_approval.py` 与 TS 侧提案通道），低影响直接执行 |
| 4 | `roveagent/api/capability_router.py` | 无需改动（`skills` toolset 已覆盖目标 persona） |
| 5 | `tests` / `*_test.py` | §5 的 9 条用例 |
| 6 | `src/lib/agent/skill-router.ts`（TS） | 提示词里告知 Agent 现在可以 fetch → 让「搜到就装」这条链路真的走起来 |

零新增依赖：`git` 是系统二进制，URL 解析复用现有函数。

---

## 附：本文档纠正过的一处我自己的错误结论

设计初稿里我写过「扫描器查的是代码级模式，查不了 prompt injection」。**这是错的**：
`scanner.py:146-154` 已经有指令覆盖（CRITICAL）、角色重设 `you are now a`（HIGH）、
`new system instructions:`（HIGH）、系统提示词抽取（HIGH）、上下文外泄（CRITICAL）
等针对性模式。真实结论应当是：**有覆盖，但不完备**。
