# Phase 6-A Complete — Social Publishing Infrastructure

**日期**：2026-09-12
**约束遵守**：**未接入任何真实平台 OAuth**。三个平台 adapter 只建立 interface，`publish()` 一律拒绝，无任何网络调用（有测试按源码断言）。
**前置**：`docs/phase5-search-system-report.md`

---

## 交付范围

按要求自建的七个部分。设计上的一条主线：**gateway 不新增权限系统，只复用既有的那一个。**

| # | 要求 | 实现位置 | 复用的既有设施 |
|---|---|---|---|
| 1 | Social publishing gateway | `roveagent/social/gateway.py` | `enterprise.approval_grants`、`enterprise.audit` |
| 2 | Canonical content hash | `roveagent/social/content.py` | 与 `approval_grants.fingerprint` **逐字节一致**（有测试锁定） |
| 3 | Single execution token | `gateway.publish()` | `claim_resolution` + `consume_grant`（两道，非新增） |
| 4 | Approval gate | `gateway.authorize()` + `SOCIAL_PUBLISH_POLICIES` | `EnterpriseToolGate` 的策略前置扩展点 |
| 5 | Audit log | `gateway._record()` | `enterprise.audit.AuditLog`（append-only JSONL） |
| 6 | 三平台 validator | `roveagent/social/validators.py` | —— |
| 7 | Adapter interface | `roveagent/social/adapters.py` | —— |
| 8 | 测试 | `social_publishing_test.py` | **90 passed / 42 subtests** |

---

## 三处需要判断力的设计决定

### 决定 1：canonical hash 绑定到**内容字节**，媒体按**内容摘要**寻址

审批是对**具体字节**的承诺。如果承诺绑定的是"发那条营销帖"而不是确切的文案与素材，那么任何能在审批与执行之间改动帖子的东西都会**静默继承该审批**。

因此：`content_hash` 覆盖平台 + 归一化文本 + **每个媒体资产的 sha256 内容摘要**。媒体**绝不按路径或 URL 寻址** —— 路径寻址会让文件在审批后被换掉而哈希不变，正是哈希要防的事。

归一化只做**可证明不可见**的变换（NFC 合成、CRLF→LF）。**不裁剪首尾空白**：裁剪会让两个真正不同的载荷塌缩成同一个哈希。

验证的性质（均有测试）：
- 等价输入（`café` 合成式 vs 分解式）→ 同一哈希
- 媒体**顺序**改变 → 哈希改变（轮播按序发布，顺序即内容）
- 媒体字节改变 → 哈希改变
- 平台改变 → 哈希改变（同一文案在两家平台的发布结果不同）
- 标签**大小写**敏感（`#Launch` 与 `#launch` 渲染不同）；前导 `#` 会被剥离使两种写法等价

### 决定 2：一处真实缺陷 —— 篡改内容曾能"烧掉"诚实审批

初版我按「先 claim、后 consume」排序。测试抓到了它的后果：

```
publish(篡改后的内容)
  → 状态分类: ready        (只按 invocation_id/execution_id 查，没比对内容)
  → claim_resolution: 成功  ← 状态被改写
  → consume_grant: 指纹不匹配 → None
  → 抛 PublicationAlreadyExecuted
```

**篡改尝试通过了前两道门，只被最后一道非原子防线拦下，而且已经污染了 claim 状态** —— 此后诚实的发布再也无法进行（`test_tampering_does_not_consume_the_original_approval` 正是断言这一点）。

**修法**：把内容指纹比对提到**任何 mutation 之前**。现在篡改在第一个门就被 `PublicationContentChanged` 拒绝，授权状态一字未动，诚实发布随后仍可成功。

这条修正把一个「篡改只是不成功」的系统，变成了「篡改完全无害」。

### 决定 3：拒绝 vs 已执行，必须分清

初版对**被拒绝**的发布报 `PublicationAlreadyExecuted`（"已执行过"）。这既不准确，也让 `claim_resolution` **改写了一个人的拒绝记录**（`status: rejected` → `resuming`）。

根因是 `find_grant()` 把所有不可用情形（缺失/被拒/过期/已消费）折叠成一个 `None`。诊断需要区分它们 —— 因为补救方式完全不同：被拒需要**新的决定**，过期需要**重新冻结**，已消费是**重放尝试**。

**修法**：在 `approval_grants.py` 补两个**加法式只读**函数 `inspect_grant()` / `classify_grant()`，且明写「仅供诊断，`consume_grant` 仍是执行的唯一权威」。**未改动任何判定语义**。

---

## 平台内容规则：只强制**已核实**的限制

每条数值限制都带来源与检索日期。**未核实的数字比没有检查更糟** —— 它会一边拒绝合法帖子，一边以权威姿态放行非法帖子。

| 平台 | 限制 | 来源（检索于 2026-09-12） |
|---|---|---|
| LinkedIn | 正文 ≤ 3000 字符；≤9 图 / 1 视频 | [LinkedIn Help](https://www.linkedin.com/help/linkedin/answer/a528176)、[MS UGC Post API](https://learn.microsoft.com/en-us/linkedin/compliance/integrations/shares/ugc-post-api) |
| TikTok | 文案 ≤ **2200 UTF-16 code units**；视频 3–600s；单文件 ≤1GB | [TikTok Content Posting API](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post)、[zernio](https://zernio.com/blog/tiktok-posting-api) |
| YouTube | 标题 ≤100；描述 ≤5000；必须视频 | [YouTube Data API videos](https://developers.google.com/youtube/v3/docs/videos)、[typecount](https://typecount.com/blog/youtube-description-character-limit) |

**YouTube 的标签预算（常被引作 500 字符）刻意不强制** —— 无法对一手来源核实。代码与 `notes` 字段都写明了这个省略及其理由。

**TikTok 的 UTF-16 细节是有实质影响的**：Python 的 `len()` 数的是码点，emoji 算 1，而 TikTok 收 2。用 `len()` 会**低估计数并放行超长文案**。有专门测试：

```
1101 个 🚀  →  len() = 1101 (< 2200，用 len 检查会放行)
              utf16_length() = 2202 (> 2200，正确拒绝)
```

**错误与警告分开**：`error` 阻止发布，`warning` 只记录判断（会被裁切的宽高比、会被截断的正文）。合并二者要么阻止合法帖子，要么隐藏真问题。

---

## Adapter：interface only，且这一承诺由测试按源码断言

三个 adapter（LinkedIn / TikTok / YouTube）声明能力与所需凭据，**都不覆写 `publish()`**，因此继承基类那个永远抛 `AdapterNotImplemented` 的实现。

`implemented()` 用**内省**判定（`type(adapter).publish is not PlatformAdapter.publish`），**不是手维护的标志位** —— 于是"这个平台能不能发"的答案不可能与代码漂移。

出错信息按平台说明缺什么，不会只说"未实现"：

```
YouTube publishing is not implemented in this build. It requires an OAuth client
with the youtube.upload scope and a videos.insert quota allocation. Content was
validated and the approval path was exercised; nothing was sent.
```

**有一处测试是唯一能真正锁住这个承诺的方式** —— 扫描包内所有 `.py`，断言不出现 `import requests` / `httpx` / `urllib.request` / `aiohttp` / `socket`。接口承诺靠源码验证，不靠信任。

**Gateway 的成功路径仍然被端到端验证**：用测试内定义的 `_RecordingAdapter`（满足接口、记录调用、不发包）走通 freeze → authorize → publish → receipt 全流程。这是 Phase 4 用过的同一模式。**没有伪造任何厂商响应** —— 那恰恰是最该避免的事，会让未建的集成看起来已完成。

---

## 单次执行：两道门，防两个不同的重放向量

| 门 | 机制 | 防什么 |
|---|---|---|
| 1 | `claim_resolution(invocation_id, execution_id)` | 重复的 resume 回调（同一 invocation 被 resume 两次） |
| 2 | `consume_grant(tenant, business, tool, args, request_id)` | 同一份授权被第二个消费者再次使用 |

两者**故意同时保留**：它们独立失效，守着不同的入口。并发测试（6 线程同时发布）断言**恰好一次成功、adapter 恰好被调用一次**。

---

## Gate 策略：作为**可选策略包**，不进默认表

`SOCIAL_PUBLISH_POLICIES` 放在 `gateway.py`，**没有**并入 `tools.framework.DEFAULT_POLICIES`。

理由：本构建里没有任何 adapter 能发布，默认表里加一行就是在治理一个**永远不会执行**的工具 —— 那正是我在 Phase 1 从进程策略里移除过的**死行**。`EnterpriseToolGate.__init__` 会把调用方策略**前置**，这正是设计好的扩展点：

```python
gate = EnterpriseToolGate(policies=list(SOCIAL_PUBLISH_POLICIES))
```

策略内容：`publish_social_post` → `comms:publish`，HIGH，**OWNER**（对外发布不可逆且公开，对齐 `send_customer_recovery_campaign` 而非泛化的 `send_*`）；两个只读辅助 → LOW / NONE。有测试断言这些行在前置后**不被更早的模式遮蔽**。

---

## 修改文件

| # | 文件 | 动作 |
|---|---|---|
| 1 | `roveagent/social/__init__.py` | 新建 |
| 2 | `roveagent/social/content.py` | 新建（canonical hash、内容模型） |
| 3 | `roveagent/social/validators.py` | 新建（三平台规则 + 来源表） |
| 4 | `roveagent/social/adapters.py` | 新建（interface only） |
| 5 | `roveagent/social/gateway.py` | 新建（gateway + 策略包） |
| 6 | `roveagent/social/social_publishing_test.py` | 新建（90 测试 / 42 subtests） |
| 7 | `roveagent/enterprise/approval_grants.py` | **改**：新增只读 `inspect_grant` / `classify_grant`（仅诊断，判定语义未动） |

**未修改**：`EnterpriseToolGate` 的授权逻辑与 `DEFAULT_POLICIES`、`audit.py`、任何 provider、`package.json`。
**未新增依赖**：仅 Python 标准库（`dataclasses` / `hashlib` / `json` / `unicodedata` / `secrets` / `shutil` / `tempfile`）。

---

## 测试结果（全部实测，2026-09-12）

```
$ python -m pytest roveagent/social/social_publishing_test.py -q
90 passed, 42 subtests passed in 0.80s

$ python -m pytest roveagent -q --ignore=roveagent/skills_library
437 passed, 357 subtests passed, 1 failed in 20.59s

$ pnpm exec tsc -p tsconfig.json --noEmit
exit 0

$ pnpm exec tsx --test tests/{roveagent-stream-contract,runtime-status-contract,
                              runtime-fallback-policy,runtime-recovery,artifacts-pdf}.test.ts
tests 73  pass 73  fail 0
```

覆盖的关键性质：
- 哈希稳定性与敏感性（等价输入、媒体顺序、媒体字节、平台、大小写）
- 跨模块哈希一致性（`content_hash` 与 `approval_grants.fingerprint` 逐字节相等）
- 未审批不可发布；被拒不可发布；**被拒不报"已执行"且状态不被改写**
- 单次执行：同实例重放、**跨 gateway 实例重放**、6 线程并发
- **篡改内容在第一个门被拒，且不消耗诚实审批**
- 无效内容被拒**且不消耗审批**（避免验证 bug 逼出第二次人工决定）
- 未实现/未知平台被拒**且不消耗审批**
- 全流程审计（frozen / approved / rejected / started / succeeded / failed / replay_blocked / expired）
- adapter 失败被审计且授权标记为 `failed`
- 源码级断言：包内无任何 HTTP 客户端导入

---

## 新发现风险

| # | 风险 | 说明 | 处置 |
|---|---|---|---|
| **R26** | **发布链路整体未与真实平台对接** | 不是"未完成"，是**本构建的设计边界**：无 adapter 可发布 | 需凭据 + 应用审核；gateway 与治理已就绪，实现 adapter + 注册即可 |
| **R27** | **平台限制会漂移** | 三家限制均为 2026-09-12 检索。上游改动后 `validators.py` 会静默错误 | 每处限制都带 `source` + `retrieved`；建议定期复核，代码里已标明 |
| **R28** | **扫描器是启发式，不是证明** | 与 Phase 3 的插件扫描同类。一个 `import re` 就能绕过任何模式 | 已文档化。价值在于抓粗心与廉价攻击，并让复核有据可依 |
| **R29** | **审批冻结窗口内内容仍可变** | 冻结后若有人改了内容，指纹会拦下；但**用户会看到"内容已变"而非"谁改的"** | 无法从哈希反推改动者，属固有限制 |
| **R30** | `grant_root` 与审计路径并存两套 | `approval_grants` 用 `ROVEAGENT_ROOT`，`AuditLog` 由 gateway 显式传入 | gateway 默认同根；测试用临时目录。部署时需确认二者同根 |
| R23/R24 | 见 Phase 5 报告 | 未变 | — |

---

## Confidence & gaps

**高置信（本机实测，可复现）**
- 90 passed / 42 subtests，含并发单次执行与跨实例重放
- 篡改内容在第一个门被拒、授权零消耗、诚实发布随后成功
- 被拒发布报 `PublicationRejected` 且授权状态保持 `rejected`
- 跨模块哈希逐字节一致；源码级断言包内无 HTTP 客户端
- 全量 Python 437 passed / 357 subtests（唯一失败为既有构建产物缺失）；`tsc` exit 0；TS 73/73

**中置信**
- 平台限制的正确性依赖所列来源当日准确；未做二次交叉验证（YouTube 标签预算即因此被省略）
- 启发式模式对**明确**写出的攻击文本有效；对改写、编码、间接表述的效果未经对抗测试

**未验证（明确缺口）**
- **与任何真实平台的对接**：零。这是本构建的设计边界，非缺陷
- **`SOCIAL_PUBLISH_POLICIES` 在真实 `EnterpriseToolGate` 请求链路中的端到端行为**：只验证了 `policy_for()` 的解析与不遮蔽，未接入 `api/app.py` 的审批流程
- **审计日志的跨进程并发安全**：`AuditLog.record` 是 `open(..., "a")` 追加写，未加锁。单进程测试通过；多进程并发写同一文件未验证（属既有 `audit.py` 的性质，本阶段未改动它）
- **`classify_grant` 的过期分支**：仅通过把 TTL 视为时间差验证逻辑，未做真实等待 3600s 的测试
