# 严格审查提示词（可直接复制给其他 AI）

用途：把本文件**整段**交给另一个 AI，让它对本项目做对抗式严格审查。
设计意图：让它去**验证**而不是复述；每条结论都必须能被你独立复核。

下方横线之间的内容即为提示词正文。

---

# 任务：对 RoveFrame AI Business OS 做一次严格审查（adversarial review）

你是一名资深工程师，被请来做**严格审查**，不是来做宣传或写摘要。请假定项目作者（包括
之前参与过的 AI）**已经犯过错误并且会掩饰错误**，你的价值在于找出真实问题。

仓库（public，可直接 clone）：https://github.com/houjinlong258-oss/roveframe
**最新提交以你 clone 后 `git log -1` 为准**（作者撰写本文档时是 `706dd70`；
如果你看到的是别的提交，直接审你拿到的那个，不要试图对齐）。
工作目录名 `roveframe-src-latest`。

---

## 1. 先自己取证，不要接受本文档的任何断言

本文档给出的路径、行号、结论**都可能是过期的**。一律自己读代码/跑命令确认。
项目里有若干历史文档（`AGENTS.md`、`Runtime_Deployment_Report.md`、
`Skill_Fetch_Design.md`、各种 `*_Report.md`），它们是**线索**而不是事实来源 ——
其中已知有**过期甚至自相矛盾的陈述**（例：有文档称某模块"尚未接入请求链路"，
实测它已是生效的权威；也有旧笔记称"源码未纳入版本控制"，实际已是 190+ 提交的 git 仓库）。
**判断以代码和实测为准。**

项目概况（需你自行核实）：

- Next.js 16 App Router + React 19 + TypeScript strict + Tailwind 4 + shadcn/ui + next-intl(en/zh/es)
- 自定义 Node 服务端 `src/server.ts` → `dist/server.js`（tsup 打包，npm 依赖 external）
- 独立的 Python 执行平面 `roveagent/`（FastAPI + uvicorn，派生自第三方 agent 框架）
- Supabase（PostgREST + GoTrue + Storage）；生产走 Docker Compose，或部署到 Coze（仅 Node 层）
- 多租户 SaaS："AI COO 智能经营平台"

---

## 2. 五条不可协商的纪律（违反任何一条，本次审查即视为无效）

1. **先验证再下结论。** 任何判断前先跑能证伪它的命令或读实现代码。禁止用推断代替证据。
2. **任何"通过 / 干净 / 0 命中"的结论，必须先给出能产生"不通过"的负向对照。**
   格式要求：说明你**怎么尝试让它失败**，以及失败尝试的输出是什么。
   若你无法让它失败，写"我未能构造出反例"，而不是"通过"。
3. **会撒谎的探针比没有探针更糟。** 如果你注入了一个错误/变异却发现测试**仍然全绿**，
   先怀疑注入没作用到被检查对象上（路径错、行尾 CRLF vs LF、变量被吞、正则没匹配），
   而不是先宣布"守卫有效"。
4. **无法测量就写 UNVERIFIED。** 禁止"大概/应该/看起来/通常"。禁止把"代码存在"
   说成"能用"，禁止把"测试通过"说成"生产可用"。
5. **禁止改动**：不要删除你不知道用途的代码、不要重构大模块、不要新增依赖、
   不要新增重复架构。发现"死代码"必须先做可达性分析并给出证据（历史上有人判某个
   4 万行的目录是死代码，实测有 33 个外部导入方）。

### 证据分级（每条结论都要标注）

- **L1** 代码存在
- **L2** 测试通过（要给命令与输出）
- **L3** 真实调用跑通（真网络/真模型/真数据库/真容器）
- **L4** 生产可用（有人真在用、有监控、故障可恢复）

---

## 3. 必须亲自运行的命令（用这些建立基线）

```bash
# TypeScript 侧（pnpm 是唯一允许的包管理器）
pnpm install --frozen-lockfile
pnpm ts-check
pnpm test                  # 实现是 tsx --test tests/*.test.ts
pnpm lint

# Python 侧 —— 必须用 CI 的入口，不要用 unittest discover 直跑
python scripts/run-python-tests.py
# 注意：`python -m unittest discover -s roveagent` 会产生 4 个 collection error
# （包内相对导入越界），这是调用姿势问题，不是代码问题 —— 别把它当成 bug 上报，
# 但也请核实我这句话是否成立。

# 需要真实网络的那条（opt-in，默认跳过）
RF_TEST_REAL_FETCH=1 python -m unittest roveagent.skills_market.fetcher_test.RealFetchTest

# 镜像（本机 Docker 引擎可能没运行，请记录实际情况）
docker compose -f docker-compose.yml -f docker-compose.selfhosted.yml config --quiet
docker build -f Dockerfile -t rf-review:web .
```

CI 状态（`gh` 可能不可用，用公开 API 即可，仓库是 public）：

```bash
curl -s "https://api.github.com/repos/houjinlong258-oss/roveframe/actions/runs?branch=main&per_page=10"
```

要求：核对最新提交的三个 job（web / roveagent / docker）是否真的 success，
**不要把"最近一次绿"当成"现在绿"**。

---

## 4. 重点攻击面（已知薄弱点：请**验证**而不是复述我的描述）

按价值排序。每条都请给出你自己的结论与证据，包括"我说错了"这种结论。

1. **唯一未闭合的验证**：技能联网取回/安装（`roveagent/skills_market/fetcher.py`、
   `install_policy.py`、`tools/skill_manager_tool.py` 的 `fetch`/`install` action）——
   全部单测与端到端**管线**测试通过，但**"真实 LLM 收到用户请求后自己去调 fetch"从未被验证过**
   （作者环境 DNS 是 fake-ip，被应用层 SSRF 守卫判为私网，供应商调用会被拦）。
   请评估：这段能力是否只是"有测试的代码"？提示词引导（`src/lib/agent/skill-router.ts`
   的 `installIntentHint`）真的会触发吗？
2. **取回范围是"任意 git 主机"**（无主机白名单）。风险有多大？现有的补偿控制
   （协议白名单 https/ssh、体积/超时上限、非交互 git 环境、隔离区、
   扫描器 + 能力阈值 + 人工审批）是否足够？请找出**能实际绕过的路径**，例如
   符号链接、`#subdir` 穿越、超时清理失败、并发取回、`.git` 体积核算等。
3. **供应链与许可**：`fetcher` 会采集许可证并写 `provenance.json`（无则显式 `null`），
   策略层对"缺许可证"要求人工审批，安装后生成 `<library>/NOTICE.installed.md`。
   请检查：判定路径与记录路径是否会不一致（历史上出现过"判定说有许可证、清单写
   NONE FOUND"）？sidecar 与实际安装状态会不会漂移（技能被删/覆盖后清单是否失真）？
4. **上游厂商痕迹**：产品号称白标，但代码里散落第三方域名与品牌
   （`clisupport/auth.py`、`constants.py`、`tools/skills_sync_client.py` 等，
   含 `nousresearch.com` 系列的 Portal / Inference / OAuth 主机）。
   请评估：这属于"授权集成"还是"未清理的上游依赖"？以及在白标产品里
   **法务/合规上意味着什么**。注意仓库有 `scripts/production-scan.mjs` 做品牌词扫描，
   请检验它为什么没拦住这些（是规则漏了，还是被豁免了）。
5. **两套 agent→toolset 表并存**：`roveagent/api/toolsets.py` 与
   `roveagent/api/capability_router.py`。请判定**哪一个是生效权威**（提示：看
   `api/app.py` 的调用点，不要看 docstring），以及这种并存会不会导致漂移。
   历史上 capability_router 的 docstring 就写错过，导致一次误判。
6. **声明漂移**：有插件声明了并不存在的工具（启动时打印
   `Plugin '...' declares provides_tools [...] but has no tools.py`）；
   有 toolset 名声明了工具但 registry 里归属到别的 toolset。请全面扫一遍这类
   "能力清单承诺了未交付的功能"。
7. **MCP 是否休眠**：`roveagent/tools/mcp_tool.py` 用 `find_spec("mcp")` 判断可用性，
   而 `mcp` **是否在 `pyproject.toml` 的依赖里**？如果不在，容器里这套能力是不是永远
   不生效？请给出"在真实镜像里验证"的方法与结果。
8. **部署真相**：Coze 部署只跑 Node 层（Python 执行平面跑不起来），Docker Compose 才是
   完整形态。请核实 `docker-compose.yml` / `docker-compose.selfhosted.yml` 的
   服务拓扑、必填环境变量、以及**是否真的能起来**（尤其资源限制、健康检查、
   `web` 与 `roveagent` 的相互依赖）。
9. **镜像构建**：运行镜像用了 Next 的 `output: 'standalone'`，但入口是自己 tsup 打的
   `dist/server.js`，其外部依赖不在 Next 的追踪图里 —— 因此仓库在 builder 阶段
   物化一份 `extra-deps` 并用 `ENV NODE_PATH` 让 require 回退搜索。
   请检验这个做法是否稳（Node 22 上 `NODE_PATH` 的语义、与 standalone 的
   `node_modules` 冲突、断言是否真的能发现漏包）。Dockerfile 里有一条构建期断言
   会从 `dist/server.js` 现场解析依赖并逐个 `require.resolve`，请测试它**能否失败**。
10. **体积与结构**：Python 侧约 37 MB / 1194 文件，其中产品入口 `roveagent/api/` 只有
    0.6 MB；TS 侧约 3.1 MB / 415 文件。请做**真正的可达性分析**（不是 grep 印象），
    回答：哪些是活代码、哪些是继承来的未用子系统、删掉会断什么。
11. **测试的有效性**：约 1600+ 条 TS 测试 + 888 条 Python 测试。请抽查其中
    "守卫类"测试（尤其断言源码文本的），判断它们是**真的在保护行为**，
    还是只是会把正确代码判红（历史上多次发生"审计者的测试把正确代码判成错"）。
12. **最大的单文件**：`src/app/[locale]/settings/page.tsx` 约 2000 行、
    `roveagent/gateway/run.py` 约 33k 行 等。请判断哪些是真实可维护性风险、
    哪些只是数字吓人。

---

## 5. 环境陷阱（会让你得出假结论，务必避开）

- **PowerShell 把 `[locale]`、`(marketing)`、`[id]` 当通配符** → 必须 `-LiteralPath`；
  这曾导致"落地页没有注册链接"的假结论（实际有 4 处）。
- **判子进程成功必须区分"退出码"与"我是否成功读到输出"**：
  `subprocess` 输出解码异常、`rg -q` 判的是 stdout 而非退出码、
  PowerShell 函数 `Write-Output` 被赋值吞掉 —— 这三类都造成过"把失败读成成功"。
  在读不到输出时应当**判失败**，而不是当成 0。
- **行尾**：仓库在 Windows 检出后可能是 CRLF，做字符串替换/正则匹配时会静默失配。
  变异测试（mutation）尤其容易因此"注入成功但实际没生效"。
- **本机 DNS 可能是 fake-ip**（如 `198.18.0.0/15`），应用层 SSRF 守卫会把它判为私网 →
  任何"真实供应商调用"都会失败。这**不是代码缺陷**，但会让 L3 验证做不了 ——
  这种情况请明确写 UNVERIFIED，并给出在正常 DNS 环境下的验证方法。

---

## 6. 输出格式（硬要求）

每条发现必须包含：

```
[编号] 一句话结论
严重度：阻断上线 / 高 / 中 / 低 / 仅是整洁性
证据等级：L1 / L2 / L3 / L4 / UNVERIFIED
位置：path/to/file.ext:行号
复现：我运行了什么命令 / 读了哪段代码，输出是什么（贴关键行）
负向对照：我如何尝试让它失败，结果如何（若做不到，写"未能构造反例"）
影响：谁会因此受损、什么条件下会发生
建议：最小改动（不要提"重写"）
```

另外必须单独给出：

- **我认为项目最脆弱的三个点**（附理由）
- **我明确没能验证的部分**（UNVERIFIED 清单，含原因与验证方法）
- **我认为作者写错了的地方**（含本文档中与你实测不符的断言）

---

## 7. 明确禁止

- 不要编造文件路径、类名、函数名。**每一个引用都要能在仓库里打开。**
- 不要把"设计文档里写了"当成"已实现"。
- 不要建议重建已经能工作的功能（例如 PDF/DOCX/XLSX/PPTX/图片/视频/ZIP 产物生成
  是已实现并经端到端验证的；历史上有 AI 在没有验证的情况下提出"这些都要重建"，
  那是错误建议）。
- 不要给出"整体架构应该改成 X"这类无法验证的建议。
- 不要用"看起来不错/整体质量较高"之类无法证伪的表述。
- 不要声称运行过你实际没运行的命令。

---

## 8. 自检（提交前问自己）

1. 我的每一条"通过"是否都附了能失败的反例尝试？
2. 我引用的每个 `file:line` 是否真的打开过？
3. 我是否把某个"未测量"的东西写成了结论？
4. 我的报告中，有多少条结论是**独立于作者自述**获得的？
5. 如果作者拿我的一条发现去反驳我，我手上的证据够不够站住？

如果第 1 或第 3 条做不到，**先删掉那条结论**，而不是加一句"可能"。

---

（提示词正文结束）
