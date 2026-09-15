# Git & Security Baseline Report

Phase 11 / Task 1. 范围：把 `roveframe-src-latest` 工作树纳入版本控制，修正凭据可见性，建立可回滚基线。
所有数字来自本次实测命令输出。未验证项显式标注 UNVERIFIED。

---

## 1. 初始状态（实测）

| 检查项 | 结果 |
|---|---|
| `git rev-parse --show-toplevel` | `D:/RoveFrame AI Business OS/RoveFrame AI Business OS`（**父目录**，非项目目录） |
| 工作树在该仓库中的状态 | `?? roveframe-src-latest/` —— 完全未跟踪 |
| 仓库最后一次提交 | `7a7f90d`，2026-09-08 |
| 工作树最新文件时间 | 2026-09-15 |
| 父目录根本身 | 同一项目的**旧副本**（`src/`、`roveagent/`、`scripts/` 等同名路径），外加 7 个 ZIP 快照 |

结论：2026-09-08 之后的全部工作（Phase 1 → Phase 10.7）只以散落文件形式存在，**没有回滚点**。
这是审计报告 P0-2 的原文结论，本次实测完全复现。

---

## 2. 仓库边界决策

两条路径可选。

| 方案 | 做法 | 评估 |
|---|---|---|
| A（采纳） | 在项目目录建立独立仓库，用父仓库 `main` 播种索引 | 仓库根 = 项目根；保留完整历史；`git status` 显示真实增量 |
| B（否决） | 在原父仓库中 `git add roveframe-src-latest/` | 仓库根仍非项目根；2041 个 09-08 旧副本与活动代码长期并存；路径变成 `roveframe-src-latest/src/...` |

采纳 A 的关键依据：父仓库跟踪的路径（`src/`、`roveagent/`、`scripts/`…）与本目录的相对路径**完全一致**，
说明父仓库本就是该项目的仓库，`7a7f90d` 是本工作树的真实祖先提交。
因此播种索引后得到的差异就是纯粹的 09-08 → 09-15 增量，而不是一份全新快照。

### 执行步骤（`--mixed` 全程不触碰工作树文件）

```
git init -b main
git remote add origin "<父目录>"
git fetch origin
git reset --mixed origin/main
```

### 执行中发现的错误与修正

首次执行用了 `git reset --mixed FETCH_HEAD`。`git fetch origin` 拉取了**两个**分支，`FETCH_HEAD`
首行是 `agent/cprop_demo_readme` 而非 `main`，于是索引被播种到了错误的分支上——表现为 `.env.example`
不在索引中、且多出 8 个不存在于本树的"删除"。

改为显式使用 `origin/main` 后差异变为 217 条，与预期一致。
**教训**：`FETCH_HEAD` 在多分支 fetch 后不指向默认分支，不可作为 HEAD 代称。

---

## 3. Baseline commit

| 项 | 值 |
|---|---|
| Commit | `78e5684` |
| 父提交 | `7a7f90d`（2026-09-08，来自父仓库 `main`） |
| 变更 | 255 files changed, 53680 insertions(+), 7193 deletions(-) |
| 明细 | 175 added / 63 modified / 17 removed |
| 提交后工作树 | `git status --porcelain` 为空（干净） |

### 17 个删除项的处理

不是删除代码，而是这些文件在本工作树中确实不存在：

- 14 个 `.cozeproj/**`（`prototype/web/*.html` 设计原型 + `documents/plan.md`）
- `.babelrc`
- `PRODUCTION_GAP_PLAN.md`、`SECURITY_FIX_PLAN.md`、`SECURITY_HARDENING_REPORT.md`

其中相当一部分是**被搬迁**而非丢失：`RoveFrame_AI_Business_OS_Fused_Blueprint.md`、`DESIGN.md`、
`TECH_SUMMARY.md` 等 22 个文档现位于 `docs/archive/`。

其余已确认可从历史取回，未做任何不可逆操作：

```
git cat-file -e origin/main:.cozeproj/prototype/web/home.html   → OK
git cat-file -e origin/main:.babelrc                            → OK
git cat-file -e origin/main:SECURITY_FIX_PLAN.md                → OK
```

**待决**：`.cozeproj/prototype/web/*.html` 是 `AGENTS.md` 声明的"页面视觉唯一标准"，但它不在本工作树中。
这不影响仓库可用性（历史可取回），但属于文档与现实的漂移，需要产品侧确认是否应恢复。

---

## 4. .gitignore 修正

### 问题

`.gitignore` 第 15 行是 `.env`，第 16 行是 `.env.*`。
两者都**不匹配** `deploy.env` —— 所以 `scripts/deploy.env` 一直处于**未忽略**状态。

实测：

```
git check-ignore -v scripts/deploy.env   → exit 1（未忽略）
```

该文件内容（仅键名与长度，未打印任何值）：

| 键 | 值长度 |
|---|---|
| `COZE_SUPABASE_URL` | 40 |
| `COZE_SUPABASE_ANON_KEY` | 208 |
| `COZE_SUPABASE_SERVICE_ROLE_KEY` | **219** |
| `COZE_SUPABASE_JWT_SECRET` | **88** |

即：一个 `git add -A` 就会把数据库超级用户凭据与 JWT 签名密钥提交进历史。

### 修正

```gitignore
scripts/deploy.env
scripts/*.env
*.env
!.env.example
```

按**模式**排除而非按精确文件名，因此未来新增 `scripts/staging.env` 之类也不会静默变成可提交。
`.env.example` 只含占位符，继续跟踪。

### 验证

```
git check-ignore -v scripts/deploy.env   → .gitignore:204:*.env   exit 0（已忽略）
git check-ignore -v .env                 → .gitignore:204:*.env   exit 0（已忽略）
git check-ignore -v .env.example         → exit 1（不忽略，正确）
```

---

## 5. .dockerignore 修正

原 `.dockerignore` 第 3-5 行只忽略 `.env` / `.env.*` / `!.env.example`，
同样漏掉 `scripts/deploy.env`。

后果比 git 侧更严重：`src/storage/database/supabase-client.ts:25` 用
`dotenv.config({ override: true, path })` 加载该文件 —— 一旦被 COPY 进镜像层，
它会**静默覆盖**容器注入的环境变量（`override: true`），
导致密钥轮换必须重建镜像而不是重启容器，且凭据永久留在层里。

已加入 `scripts/deploy.env`、`scripts/*.env`、`*.env`，并附注释说明原因。

---

## 6. Secret 扫描

三层，全部在 `git add -A` 之后、commit 之前对**暂存索引**执行。

### 6.1 仓库自带扫描器

```
pnpm scan:secrets → Production scan (secrets) passed across 2199 source file(s)
```

### 6.2 真实凭据值比对（最强证据）

把 `scripts/deploy.env` 与 `.env` 中的真实值作为**字面量**在暂存索引中检索。
值从不打印。

| 凭据 | 长度 | 索引命中 |
|---|---|---|
| `COZE_SUPABASE_URL` | 40 | 0 |
| `COZE_SUPABASE_ANON_KEY` | 208 | 0 |
| `COZE_SUPABASE_SERVICE_ROLE_KEY` | 219 | 0 |
| `COZE_SUPABASE_JWT_SECRET` | 88 | 0 |
| `ROVEAGENT_API_KEY` | 48 | 0 |
| `ROVEAGENT_APPROVAL_SECRET` | 48 | 0 |
| `ROVEAGENT_API_URL` | 21 | 12 —— 值即 `http://127.0.0.1:8788`，本地地址，非凭据 |

```
git diff --cached --name-only | grep 'deploy.env|\.env$'  → 无输出
```

### 6.3 模式扫描与逐条定性

| 模式 | 文件数 | 定性 |
|---|---|---|
| JWT base64url（`eyJ…`） | 0 | — |
| PEM 私钥块 | 2 | `roveagent/core/redact.py`（脱敏正则自身）、`tests/phase8-approval-ui.test.ts`（测试夹具） |
| `sk-…` 形 API Key | 5 | `redact.py` 文档示例、`SKILL.md` / `native-mcp.md` 中的 `sk-xxxxxxx` 占位符、两个断言"密钥不得泄漏"的测试 |
| AWS / Google / GitHub / Slack token | 0 | — |
| Supabase service JWT 字面量 | 0 | — |

**结论：暂存集内无真实凭据。** 命中的都是脱敏模式代码与合成占位符。

### 6.4 方法学修正（重要）

第一轮扫描报出"全部 0 命中"，但 `git grep` 的 `--cached` 被放在了模式**之后**，
git 报 `fatal: option '--cached' must come before non-option arguments`，
而该错误被 `2>$null` 吞掉，于是"命令失败"被误读成"没有命中"。

发现方式：用已知存在字符串做方法学阳性对照。

```
git grep --cached -I -l -F -e "SERVICE_ROLE"   → 19 files   （阳性对照通过）
```

修正为 `--cached` 前置 + `-e` 传模式后重跑，上表即为修正后的结果。
**任何"0 命中"结论都必须先有阳性对照**，否则无法区分"干净"与"命令没跑起来"。

---

## 7. 遗留风险与未决项

| # | 项 | 状态 |
|---|---|---|
| G-01 | 父仓库仍把本目录视为未跟踪 | 已知。父仓库未做任何改动；本目录现为独立仓库。是否归档父仓库旧副本需人工决定 |
| G-02 | `.cozeproj/prototype/web/*.html` 不在本工作树 | 待决，见 §3 |
| G-03 | 凭据文件本身未轮换 | 仅从跟踪范围移出。`service_role` 值曾长期处于未忽略状态，**是否曾泄漏未经验证**；建议轮换 |
| G-04 | `ENCRYPTION_SECRET` 与 `COZE_SUPABASE_SERVICE_ROLE_KEY` 复用风险 | 审计 P0 遗留项，本次未处理（属部署侧配置）；已在 `docker/deploy.env.example` 中显式警告二者必须不同 |
| G-05 | `probe_c.txt`（内容 `value = 42`） | 无害的探针残留，已加入 `.gitignore`（`probe_*.txt`），未删除 |
| G-06 | 提交历史中仍无 `.env` 类文件 | 已验证：索引与工作树均无命中 |

---

## 8. 一句话结论

仓库边界已建立：项目目录即 git 根，历史承接 `7a7f90d`，基线提交 `78e5684` 覆盖 09-08 至 09-15 的全部增量。
两个真实凭据文件（`scripts/deploy.env`、`.env`）已按模式排除并在提交前验证零泄漏。
回滚能力恢复。
