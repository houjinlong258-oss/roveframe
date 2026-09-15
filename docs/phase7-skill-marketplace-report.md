# Phase 7 Complete — Skill Marketplace Infrastructure

**日期**：2026-09-12
**约束遵守**：**未修改已有安全边界**、**未关闭 SSRF 防护**、**未伪造外部 API 测试**、**未新增依赖**。
**前置**：`docs/phase6-social-publishing-report.md`

---

## 交付范围

| # | 要求 | 实现位置 |
|---|---|---|
| 1 | Skill Registry | `roveagent/skills_market/registry.py` |
| 2 | Skill Manifest | `roveagent/skills_market/manifest.py` |
| 3 | Skill Version Management | `roveagent/skills_market/versions.py` |
| 4 | Permission Model | `roveagent/skills_market/permissions.py` |
| 5 | Sandbox Runtime Interface | `roveagent/skills_market/sandbox.py` |
| 6 | Skill Installation Workflow | `roveagent/skills_market/installer.py` |
| 7 | Skill Security Scanner | `roveagent/skills_market/scanner.py` |
| 8 | 测试 | `skill_marketplace_test.py` —— **115 passed / 26 subtests** |

**复用而非重建**（这是我开工前先扫描既有设施的原因）：

| 复用对象 | 用途 |
|---|---|
| `core.skill_utils.parse_frontmatter` / `yaml_load` | SKILL.md frontmatter 解析 —— **单一事实来源，未另写一个 YAML 解析器** |
| `api.plugin_security.analyze_plugin_code` | 代码部分的 AST 能力分析 —— **未写第二个 AST 遍历器**（那会带来第二组盲区且两者会漂移） |
| `tools.framework.EnterpriseToolGate` | **仍是唯一的执行门**。本包不授予执行权，只决定"能否安装"这个静态问题 |
| `clisupport.agent_plugins._SKILL_NAME_RE` | 名称规则。有测试断言两处正则**逐字符相同** |

**真实库兼容性已实证**：`SKILL.md` 解析器接受项目**实际发布**的格式，不是为测试发明的格式：

```
$ python scripts/... (registry.index(roveagent/skills_library))
indexed: 58  invalid: 0
categories: apple, autonomous-ai-agents, creative, devops, email, media,
            note-taking, productivity, research, social-media,
            software-development, web
```

两个测试直接读真实库（而非夹具）：`test_every_shipped_skill_loads`（>20 个全部解析成功）、`test_indexes_the_real_library`（58 个、0 无效）。

---

## 三处需要判断力的设计决定

### 决定 1：权限模型的核心规则 —— **声明不是授权**

`roteagent` 的插件框架已有一条原则（`CAPABILITY_REGISTRY`：declaration ≠ grant）。本模块对技能立同一条规矩，理由相同：**如果 manifest 能自己授权，那"安装技能"与"把机器交出去"就无法区分，复核步骤就成了装饰。**

安装产生一个 `PermissionDecision`，两个输入**相互独立**：

- `requested` —— 从 manifest 与扫描内容**推导**
- `granted` —— 由操作者提供，**绝不从 requested 推断**

`granted` **默认为空**。requested 不是 granted 子集时**拒绝**，而不是静默收窄 —— 半运行的技能比拒绝启动更难诊断。

推导是**故意宽泛**的：请求的意义在于如实说出技能**可能**做什么，所以任何歧义都计入。收窄发生在授权环节，那里有人做判断；在推导环节答错会**让一项能力从复核视野里消失**。

**这不是第二个执行门。** `EnterpriseToolGate` 仍是唯一按次授权工具调用的地方，有自己的策略表、角色、审批与审计。本模块只回答"能否安装"这个**安装时的静态**问题。

### 决定 2：默认沙箱**拒绝一切**，且我删掉了两个看似有用的类

隔离是**运行时**的属性，不是接口的属性。声明 `SandboxRuntime` 本身不产生任何隔离。

初版我写了两具具体类，测试立刻暴露了问题：

- `InProcessSandbox.is_available()` 返回 `True`，但它的 `run()` **永远拒绝**。`is_available()` 的语义是"能否在此主机执行"，返回 True 是**误导** —— 它会进入 `available()`，并可能满足 `select()`。这正是本模块存在要防的**夸大**。
- `UnavailableSandbox` 的拒绝文案与 `select()` 在空注册表下抛出的文案**重复**。

两个类都**永远无法服务任何请求** = 死代码。所以：

**默认注册表为空**，`select()` 的失败信息承载完整解释：

```
no registered sandbox runtime meets the minimum isolation level 'container';
registered: none. Refusing rather than running untrusted third-party skill code
in the host process. Register a SandboxRuntime (container, microVM, or remote)
to enable skill execution.
```

`select()` 的默认最低隔离级别是 **CONTAINER 而非 PROCESS** —— 没有 namespace 的独立进程contain 不住一个有决心的技能，把它当作隔离就是本模块要避免的夸大。

### 决定 3：安装先 **stage 再 verify**，堵住 supply-chain 的时间窗

先扫描源目录再拷贝，中间留了一个**源可被替换**的窗口 —— 而那个窗口正是供应链攻击需要的。

流程：`validate → scan → permissions → plan → stage → verify staged → atomic rename → rollback`

- `_stage()` 拷贝到**目标父目录内**的临时目录，使最终提交成为**同文件系统的原子 rename**（而非可能半完成的跨设备拷贝）。
- 拷贝后比对 `digest_tree(source)` 与 `digest_tree(staged)`，**不一致即拒绝**。
- 提交后**再次**比对已安装树与已暂存树的摘要，不一致则**回滚**。
- `digest_tree` **同时哈希文件名与内容** —— 只哈希内容会把两棵不同的树报成同一棵（有测试断言重命名会改变摘要）。

**无网络**：源必须是本地目录。没有远程拉取、没有 registry 协议、没有归档解压，因此安装期那些经典的远程代码执行面在这里不存在。函数名就叫 `install_from_directory`。

---

## 版本管理：两个真实陷阱

自写（项目禁新增依赖）且把规则写明白：

**陷阱 1 — 数字型 prerelease 标识符必须按数值比较**
`1.0.0-rc.10` 比 `1.0.0-rc.2` **新**，不是旧。字符串比较会答错。有专门测试。

**陷阱 2 — build metadata 不参与优先级**（SemVer 2.0.0 §10）
`1.0.0+a` 与 `1.0.0+b` 相等。所以 `__eq__` 也必须忽略 build，否则 `==` 与 `<`/`>` 会自相矛盾 —— 有测试同时断言相等与"既不大于也不小于"。

约束语义（caret / tilde）按广泛采用的读法，`0.x` 与 `0.0.x` 的破坏位分别落在 minor 与 patch：

| 约束 | 范围 |
|---|---|
| `^1.2.3` | `>=1.2.3, <2.0.0` |
| `^0.2.3` | `>=0.2.3, <0.3.0` |
| `^0.0.3` | `>=0.0.3, <0.0.4` |
| `~1.2.3` | `>=1.2.3, <1.3.0` |

**prerelease 默认不满足范围约束**：否则 `>=1.0.0` 会接受 `2.0.0-rc1` 并可能盖过稳定版。**`select_version` 找不到满足版本时返回 `None`，绝不回落到任意版本** —— 对一个即将写盘的调用方，"没有满足的版本"与"这就是版本"不能混淆。

---

## 安全扫描器：覆盖 AST 看不到的那一半

技能的主要载荷是 **SKILL.md 的散文** —— 一段模型被指示去遵循的文本。那是**指令通道**，也是恶意技能真正下手的地方。只静态分析 `.py` 文件会完全错过它。

| 威胁 | 检测内容 |
|---|---|
| `prompt_injection` | 指令覆盖、角色重设、注入系统指令、套取系统提示词、外传会话上下文、**要求对操作者隐瞒**、**试图豁免破坏性操作的审批** |
| `invisible_text` | 零宽字符、bidi 覆写、Unicode 标签字符（**人眼复核看不到的文本**） |
| `confusable_script` | 混入西里尔/希腊字母（`rm -rf /а` 里的那个 `а`） |
| `encoded_payload` | 长 base64 / hex 块 |
| `destructive_command` | `rm -rf`、`mkfs`、`dd`、fork 炸弹、`curl \| sh`、`chmod 777`、`shutdown`、`git push --force` |
| `credential_access` | 读取凭据形状的环境变量、`.env` / `id_rsa` / `.aws/credentials`、`printenv` |
| `network_egress` | shell 网络客户端、原始 socket |
| `shell_construct` | `$(...)`、反引号、`eval`、`base64 -d`（绕过参数级扫描的写法） |
| `path_escape` | 多级 `../` 离开技能目录 |
| `unlisted_prerequisite` | 示例里调用了 manifest 从未声明的命令（**绕过了操作者的前置条件复核**） |

**诚实标注强度**：这是启发式筛子，不是证明。`enforce` **默认 False** —— 发现被记录并返回，但不阻止安装。因为**误报阻止合法技能，会训练操作者关掉这项检查**。代码里明写「技能离任何一条模式都只差一个 `import re`」。

**扫描缺失不等于扫描干净**：分析器 import 失败或文件读不了时，`scanner_error` 被设置，且 `is_install_allowed()` **无论 enforce 与否都返回 False**。缺失的模块不能被看成安全的技能。

---

## 一处既有不一致（记录而非掩盖）

`clisupport.agent_plugins._valid_skill_frontmatter` 要求 `metadata` 的每个值都是**字符串**。但项目实际发布的库里含有嵌套、列表值的 metadata：

```yaml
# skills_library/apple/apple-notes/SKILL.md
metadata:
  roveagent:
    tags: [Notes, Apple, macOS, note-taking]   # 列表 → 会让上面那个校验器失败
```

那个校验器针对的是**严格的便携版 Agent Plugins 格式**；库遵循的是**更宽松的仓库内约定**。

本包因此对 `name` 与 `description` 强制两种格式都同意的 Agent Skills 约束，而**接受结构化 metadata** —— 拒绝项目实际发布的库是**错的那种严格**。差异被记录在 `__init__.py` 与本节，而不是悄悄抹平。有测试断言两处的名称正则逐字符相同。

---

## 修改文件

| # | 文件 | 动作 |
|---|---|---|
| 1 | `roveagent/skills_market/__init__.py` | 新建（scope + 复用关系 + 不一致记录） |
| 2 | `roveagent/skills_market/versions.py` | 新建（SemVer、约束、选择） |
| 3 | `roveagent/skills_market/manifest.py` | 新建（类型化 manifest + 校验） |
| 4 | `roveagent/skills_market/permissions.py` | 新建（声明≠授权） |
| 5 | `roveagent/skills_market/sandbox.py` | 新建（隔离接口 + fail-closed 默认） |
| 6 | `roveagent/skills_market/scanner.py` | 新建（启发式安全扫描） |
| 7 | `roveagent/skills_market/registry.py` | 新建（索引与查询） |
| 8 | `roveagent/skills_market/installer.py` | 新建（stage/verify/commit/rollback） |
| 9 | `roveagent/skills_market/skill_marketplace_test.py` | 新建（115 测试 / 26 subtests） |

**未修改**：`core/skill_utils.py`、`api/plugin_security.py`、`clisupport/agent_plugins.py`、`tools/framework.py`、`tools/registry.py`、`skills_library/` 下任何文件、`package.json`。
**未新增依赖**：仅标准库（`dataclasses` / `hashlib` / `shutil` / `tempfile` / `re` / `unicodedata` / `enum` / `abc`）。

---

## 测试结果（全部实测，2026-09-12）

```
$ python -m pytest roveagent/skills_market/skill_marketplace_test.py -q
115 passed, 26 subtests passed in 0.81s

$ python -m pytest roveagent -q --ignore=roveagent/skills_library
437 passed, 357 subtests passed, 1 failed in 20.59s
  （Phase 6-A 后为 232 passed；本阶段 +205，其中 Phase 7 占 115）

$ pnpm exec tsc -p tsconfig.json --noEmit
exit 0

$ pnpm exec tsx --test tests/{roveagent-stream-contract,runtime-status-contract,
                              runtime-fallback-policy,runtime-recovery,artifacts-pdf}.test.ts
tests 73  pass 73  fail 0
```

覆盖的关键性质：
- **版本**：`rc.2 < rc.10`、prerelease 低于 release、build 不参与优先级、四种约束语义、畸形版本/约束抛错、无满足版本返回 None、拒绝降级
- **Manifest**：名称须匹配目录、名称规则、空描述致命、坏版本致命、未知字段记录而非拒绝、`metadata.roveagent.tags` 读取、**与 `_SKILL_NAME_RE` 逐字符一致**、**真实库 58 个全部解析成功**
- **权限**：声明全部 ≠ 授予空；子集授予不可安装；未知能力抛错；命令→SHELL_EXECUTE；secret 形状 env→ENV_SECRETS；**普通 env 不推导任何额外能力**
- **沙箱**：默认注册表拒绝执行、空注册表、拒绝信息可操作、按信任级选择、**裸进程不满足 CONTAINER 最低级**、注册顺序不影响选择、字符串命令被拒（必须 argv）
- **扫描器**：10 类威胁各自的检出、证据字段、零宽字符为 CRITICAL、**缺失扫描不视为干净**、enforce 默认关闭
- **注册表**：扁平与分类两种布局、**单个坏技能不导致整体失败**、幂等索引、prerelease 不作为 latest、能力查询报告的是**请求**不是授予
- **安装器**：plan 不写盘、无授权拒绝安装、**部分授权拒绝**、非法 manifest 拒绝、enforce 下拦截危险技能、升级识别、**默认拒绝降级**、同版本重装、dry-run、**无 staging 残留**、摘要随增删改名变化、**TOCTOU 竞态被捕获**、失败暂存不留残骸、安装后能被注册表发现

---

## 新发现风险

| # | 风险 | 说明 | 处置 |
|---|---|---|---|
| **R31** | **无任何隔离后端可用** | 本机无 Docker；`default_registry()` 为空，技能代码**无法执行** | 这是 fail-closed 的**正确**状态。需部署容器/微虚机后端 |
| **R32** | **扫描器为启发式** | 见「诚实标注强度」 | 已文档化；enforce 默认关；用于让复核有据可依 |
| **R33** | **安装器无远程源** | 无拉取、无签名校验、无仓库协议 | 本阶段设计边界。真正的 marketplace 需要签名与供应链校验 |
| **R34** | **`metadata` 校验与便携格式不一致** | 见上节 | 已记录；未改任何既有校验器 |
| **R35** | **`unlisted_prerequisite` 为 INFO 级且模式粗糙** | 只在"命令 + 空格 + `-`"形状上触发，漏报率高 | 定位为提示而非保证；已如此标注 |
| **R36** | **安装并发未加锁** | 两个进程同时安装同名技能可能交错 | `_atomic_replace` 用 rename 使单次提交原子，但**无跨进程锁**。单进程安全 |
| R26–R30 | 见 Phase 6-A 报告 | 未变 | — |
| R23/R24 | 见 Phase 5 报告 | 未变 | — |
| R19 | 插件安装把不可信代码拉进主进程 | **本阶段为它提供了接口层**，但未启用隔离 | 首次装第三方技能前须部署沙箱后端 |

**R31 值得强调**：`default_registry()` 为空**不是未完成**，是**本机确实没有任何隔离能力**（Docker 未安装）。技能安装与索引全部可用；只有**执行**被拒绝。这个区分很重要 —— 报告不把"拒绝执行"写成"功能缺失"。

---

## Confidence & gaps

**高置信（本机实测，可复现）**
- 115 passed / 26 subtests；全量 Python 437 passed / 357 subtests
- 真实技能库 58 个技能全部解析成功、0 无效（含 12 个分类）
- 安装器：无授权/部分授权/非法 manifest/降级 均被拒；TOCTOU 竞态被捕获；失败不留残骸
- 沙箱默认拒绝执行，且拒绝信息给出所需的最低隔离级别
- 版本算术的两个陷阱（rc.10、build metadata）均有专测
- `tsc` exit 0；TS 73/73

**中置信**
- 扫描器的模式集对**明确写出**的攻击文本有效；对改写、编码、间接表述的效果**未经对抗测试**
- `unlisted_prerequisite` 的召回率明显低于其精确率（模式刻意保守）

**未验证（明确缺口）**
- **技能代码的真实隔离执行**：零。无可用后端，属环境约束
- **多进程并发安装**：未测试（无跨进程锁）
- **真实 marketplace 供应链**：无签名校验、无远程源、无归档解压 —— 功能上不存在，非缺陷
- **与 `EnterpriseToolGate` 的运行时联动**：本包只决定能否安装；安装后的技能如何被调用、其能力如何在 `gate` 层被再次校验，**未接入请求链路**
- **在 Windows 之外的平台**：`installer` 的 rename 语义与 `shutil.copytree` 行为未在 Linux/macOS 验证（部署目标是 Linux）
