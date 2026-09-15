# Runtime Takeover Report — Step 3.1（Runtime 状态体验收尾）

**日期**：2026-09-12
**范围**：Step 3.1 — Runtime 不可用恢复 + 状态条改为仅异常显示 + 前端测试
**约束遵守**：未进入 Stage 2；未修改权限系统；未修改 `runtime.py`、
`EnterpriseToolGate`、`PermissionEngine`、toolset 解析器
**前置**：`docs/stage3-runtime-status-fallback-policy-report.md`

---

## 1. 修改文件

| # | 文件 | 动作 | 任务 |
|---|---|---|---|
| 1 | `src/lib/agent/runtime-availability.ts` | **新建** | 1 + 2（纯逻辑层） |
| 2 | `src/app/api/agent/runtime-health/route.ts` | **新建** | 1（服务端代理探测） |
| 3 | `src/components/agent/status-strip.tsx` | 修改 | 1 + 2（`RuntimeStatusBar` 取代 `RuntimeBadge`） |
| 4 | `src/app/[locale]/agent/page.tsx` | 修改 | 1 + 2（接入 + 基础模式守卫） |
| 5 | `messages/{zh,en,es}.json` | 修改 | 三语键（10 个） |
| 6 | `tests/runtime-recovery.test.ts` | **新建** | 3（17 项） |
| 7 | `tests/runtime-fallback-policy.test.ts` | 修改 | +5 项路由/边界护栏 |

**未修改**（按你的禁止清单逐项确认）：`roveagent/runtime.py`、
`roveagent/tools/framework.py`、`roveagent/permissions/engine.py`、
`roveagent/api/toolsets.py`、`src/lib/agent/request-class.ts`（沿用 Step 3 的判定）。

---

## 2. 关键设计决定（两个必须先说清的约束）

### 2.1 为什么「重新连接」必须走 Next.js 代理路由

`src/lib/roveagent/client.ts` 经 `signature.ts` 引入 **`node:crypto`**：

```
client.ts:16   import { signRoveAgentPayload } from '@/lib/roveagent/signature';
signature.ts:1 import { createHmac, timingSafeEqual } from 'node:crypto';
```

因此它**不能**被 `'use client'` 组件引入（会打包失败）。即便能，
`ROVEAGENT_API_KEY` 也绝不能下发到浏览器。

→ 新增 `GET /api/agent/runtime-health` 由服务端代探，只回**脱敏结论**：

```ts
{ ok: boolean, mode: 'roveagent' | 'unavailable', detail: string, latencyMs: number | null }
```

有测试护栏断言该路由响应体**不含**凭据字段，且不得用 4xx/5xx 表达
「Runtime 不可用」（那是本服务对 Runtime 的一份**正常观测结果**，
用 5xx 会让前端把「Runtime 挂了」和「本路由自己出错」混为一谈）。

### 2.2 逻辑与渲染分离

把全部展示决策放进 `runtime-availability.ts` 的**纯函数**（零 import）：

```ts
bannerKindFor(mode)      → 'none' | 'warning' | 'error'
presentRuntime(status)   → { kind, visible, recoverable, detail }
applyProbeResult(cur, r) → 成功→roveagent / 失败→保持 unavailable
canSendInBasicMode(cls)  → chat=true, tool_execution=false
```

这样组件保持哑（thin），4 项验收可以用**纯单元测试**覆盖，
无需引入 DOM 测试环境或新依赖（符合本项目「不新增依赖」的既有约束）。

---

## 3. diff 摘要

### 3.1 任务 2：`RuntimeBadge` → `RuntimeStatusBar`

Step 3 的 `RuntimeBadge` 对**每种** mode 都渲染（含正常的 `roveagent`），
是视觉噪音。已删除，替换为仅异常显示：

```diff
-export function RuntimeBadge({ mode, detail, className }) { …三套配色… }
+export function RuntimeStatusBar({ status, onReconnect, onUseBasicMode,
+                                   reconnecting, basicModeActive, className }) {
+  const view = presentRuntime(status);
+  if (!view.visible) return null;          // ← roveagent 直接不渲染
+  const isError = view.kind === 'error';
+  …
+}
```

页面侧改为传 status 对象（不再靠 `message.runtimeMode &&` 兜底可见性）：

```diff
                 {message.runtimeMode && (
-                  <RuntimeBadge mode={message.runtimeMode} detail={message.runtimeDetail} />
+                  <RuntimeStatusBar
+                    status={{ mode: message.runtimeMode, detail: message.runtimeDetail }}
+                    reconnecting={runtimeReconnecting}
+                    basicModeActive={basicMode}
+                    onReconnect={() => void reconnectRuntime()}
+                    onUseBasicMode={() => setBasicMode(true)}
+                  />
                 )}
```

### 3.2 任务 1：重新连接

```ts
const reconnectRuntime = useCallback(async () => {
  setRuntimeReconnecting(true);
  try {
    const response = await fetch('/api/agent/runtime-health', { cache: 'no-store' });
    if (!response.ok) return;                    // 探测本身失败 → 保持错误，不谎报恢复
    const report = (await response.json()) as RuntimeHealthReport;
    setMessages((prev) => prev.map((message) => {
      if (message.role !== 'assistant' || !message.runtimeMode) return message;
      const applied = applyProbeResult({ mode: message.runtimeMode, detail: message.runtimeDetail }, report);
      return {
        ...message,
        runtimeMode: applied.mode,
        runtimeDetail: applied.detail,
        error: report.ok && message.error?.code === 'runtime_unavailable' ? null : message.error,
      };
    }));
    if (report.ok) setBasicMode(false);
  } catch { /* 网络异常：保持错误 */ }
  finally { setRuntimeReconnecting(false); }
}, []);
```

### 3.3 任务 1：基础模式（只允许普通聊天）

```diff
+      // 基础模式只允许普通聊天。工具类请求必须继续被拒绝：
+      // 放行等于让 TS 兜底路径「假装做过」，正是要消除的行为。
+      if (basicMode && !canSendInBasicMode(classifyRequest(trimmed).requestClass)) {
+        setMessages((prev) => [...prev,
+          { key: nextKey('user'), role: 'user', content: trimmed },
+          { key: nextKey('assistant'), role: 'assistant', content: '', pending: false,
+            notices: [{ level: 'warning', code: 'basic_mode_blocks_tool_task',
+                        message: tRuntime('basicModeBlocked') }] },
+        ]);
+        return;
+      }
```

**两道防线**：客户端预检（即时反馈）+ 服务端分类（权威判定）。
基础模式不提供任何 `tool_execution` 后备方案。

---

## 4. 测试结果

### 4.1 任务 3 的四项验收 —— 全部通过

```
$ pnpm exec tsx --test tests/runtime-recovery.test.ts
✔ 测试1 正常运行时间：roveagent 模式不显示任何 banner
✔ 测试1 缺省/空状态也不显示 banner
✔ 测试2 后备方案：fallback 显示警告（不是错误）
✔ 测试2 fallback 不提供恢复按钮（它本身可用，只是能力受限）
✔ 测试2 fallback 保留原因供展示
✔ 测试3 不可用：unavailable 显示错误且可恢复（retry 可用）
✔ 测试3 不可用时原因被保留（供展示）
✔ 测试4 retry 成功：状态恢复为 roveagent，banner 消失
✔ 测试4 retry 失败：保持错误，且原因不丢
✔ 测试4 retry 失败但无新原因时，沿用旧原因
✔ 测试4 探测结果映射：ok → roveagent，!ok → unavailable
✔ 测试4 detailAfterProbe：成功清空原因，失败保留原因
✔ 基础模式允许普通聊天
✔ 基础模式禁止一切工具类请求（不提供后备方案）
✔ bannerKindFor 覆盖全部 mode 且无遗漏
✔ visible 与 kind 始终一致（组件依赖的不变量）
ℹ tests 17  pass 17  fail 0
```

### 4.2 护栏测试（含新增 5 项）

```
$ pnpm exec tsx --test tests/runtime-fallback-policy.test.ts
✔ 工具类请求 + Runtime 不可用 ⇒ 硬失败（unavailable 分支必须 return）
✔ 分类在 Runtime 调用之前完成
✔ chat 类请求仍允许 fallback
✔ runtime_status 事件在流最开始发出
✔ session runtime 元数据被写入且带降级容错
✔ 迁移脚本存在且幂等
✔ schema.ts 已声明 runtime 元数据列
✔ runtime-health 路由对未登录返回 401（不泄露 Runtime 拓扑）
✔ runtime-health 用 200 表达「Runtime 不可用」（不是 5xx）
✔ runtime-health 不得下发凭据（只回脱敏结论）
✔ runtime-health 禁止缓存（探测必须实时）
✔ 前端不得把 roveagent client 引入客户端组件（node:crypto 依赖）
✔ task2：状态条在 roveagent 模式下必须返回 null（不渲染）
ℹ tests 29  pass 29  fail 0
```

### 4.3 全量回归

```
$ python -m pytest roveagent/api/stream_wire_test.py roveagent/api/toolsets_test.py \
      roveagent/tools/permissions_policy_test.py -q
58 passed, 72 subtests passed

$ pnpm exec tsx --test (8 套，含我新增的 4 套)
ℹ tests 84  pass 84  fail 0

$ pnpm exec tsc -p tsconfig.json --noEmit        →  exit 0
$ pnpm exec eslint src --quiet                   →  exit 0
$ node scripts/verify-migrations.mjs             →  迁移事实源比对通过
$ i18n 三语 key 一致性                            →  PARITY OK（各 10 键）
```

### 4.4 关于仓库里已存在的失败测试（**非本次引入**）

逐文件扫描发现 3 个 TS 测试文件失败，4 个 Python 文件收集报错。
已核实**与本次改动无关**：

| 失败项 | 原因 | 与本次的关系 |
|---|---|---|
| `supabase-client.test.ts` | 本机存在 `scripts/deploy.env`（内容含 `replace-me` 占位），导致 P0-2 的「缺 key 应抛错」预期不成立 | 该文件不在我的修改列表内 |
| `phase8-approval-ui.test.ts` | 需要数据库的审批状态流转 | 同上 |
| `production-hardening.test.ts` | 环境依赖 | 同上 |
| `roveagent/skills_library/productivity/{docx,pdf,pptx,xlsx}/tests` | 第三方技能的测试，导入失败 | 与 `roveagent/api`、`roveagent/tools` 无关 |

核实方式：按修改时间列出本会话改动的文件，`scripts/deploy.env` 与
`src/storage/database/supabase-client.ts` **均不在其中**（我自始至终未改动它们）。

---

## 5. Stage 2 准备建议

以下是我在打通 Runtime 接管链路过程中积累的、**进入 Stage 2 前值得先处理**的具体事项。
按「阻塞程度」排序。

### 5.1 必须先解决（否则 Stage 2 会返工）

| # | 事项 | 为什么必须先做 | 建议动作 |
|---|---|---|---|
| **P1** | **`terminal` / `process` 的 owner 自批语义** | `_role_gate` 用 `_ROLE_RANK[role] >= _ROLE_RANK[required] + 1`，因此 **owner 可自行放行 MANAGER 级动作**。Stage 2 一旦把 `terminal` 交给 devops 并真实执行，owner 身份的调用**不会进入审批**。 | 先决定：对 `HIGH`/`CRITICAL` 是否强制留审批留痕。这是产品决策，不是技术问题 |
| **P2** | **工具集可用性门控过严** | 实测出厂态 `safe=NO coding=NO` —— 组合 toolset 只要任一子项（web/vision/image_gen）缺凭据就**整体不可用**。Stage 2 做能力扩展时会遇到「配了 toolset 但工具不出现」。 | 在 Stage 2 之前给 `resolve_toolsets` 加**可用性感知**：按 `get_available_toolsets()` 过滤并记录缺失原因，而不是静默少给工具 |
| **P3** | **元数据迁移未应用** | 5 个 `runtime_*` 列需 DDL。未应用时是容错降级（有 warn），但 Stage 2 的审计需求会依赖它。 | 在具备凭据的环境执行 `scripts/migrate-runtime-metadata.sql` |
| **P4** | **TS→浏览器整段链路从未运行时验证** | Step 2/3/3.1 的 TS 侧全部只有 `tsc` + 源码护栏，**没有**一次真实浏览器验证。Stage 2 若在这之上继续叠加，问题会复合。 | 提供可用 `.env`，跑一次 `bash scripts/dev.sh` 做端到端确认 |

### 5.2 建议顺带处理（成本低、收益明确）

| # | 事项 | 说明 |
|---|---|---|
| S1 | `check_web_api_key raised` | `get_available_toolsets()` 的一个 provider 校验路径**抛异常**（不是返回 False），导致 `web` / `search` / `safe` / `coding` 连带不可用。定位成本很低 |
| S2 | `video_gen` toolset 判定与 `video_generate` 的 `check_fn` 不一致 | 前者 `yes`、后者 `False`，属内部矛盾，与 Stage 2 的媒体能力直接相关 |
| S3 | 中文 PDF 字体 | `public/fonts/` 只有 README。投一份 OFL 许可的 Noto Sans CJK 即可打通全部中文 PDF —— **一行配置，与 Stage 2 无耦合，可随时做** |
| S4 | 既有失败测试 | §4.4 的 3+4 个失败项会让 CI 长期红，掩盖真实回归 |

### 5.3 Stage 2 本身的建议形态（供参考，不属本步范围）

- `Agent → Toolset` 的映射表已就位（`roveagent/api/toolsets.py`），
  Stage 2 应**扩展这张表**而不是另建一套
- 权限判定**继续只走** `EnterpriseToolGate`（Step 1.5 已把它修到与实际工具语义一致），
  不要再引入第二套判定
- `workforce/employees.py` 里的 `tools` / `forbidden` 声明**仍未与门控真正连通** ——
  目前 `forbidden` 只是文档。Stage 2 若要「按员工档案限权」，这是接入点

---

## 6. 未验证部分（如实标注）

| 项 | 状态 |
|---|---|
| 4 项验收（纯逻辑层） | **已验证**（17 项单元测试） |
| 路由/边界护栏 | **已验证**（13 项源码护栏） |
| `/api/agent/runtime-health` 实际 HTTP 行为 | **未验证** —— 需运行中的 Next.js + 登录态 |
| 重新连接按钮的真实点击 → 探测 → 恢复 | **未验证** —— 同上 |
| 基础模式守卫在浏览器里的表现 | **未验证** —— 同上 |
| Step 3 遗留：`/api/agent/chat` 的 fallback 运行时行为（测试 2/3） | **仍未验证** —— 同上 |

本机无 `.env`（无 Supabase 凭据），无法启动完整应用。
我没有把上述任何一项填成通过。
