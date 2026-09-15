# Runtime Takeover Report — Step 3（Runtime 状态透明化与降级策略）

**日期**：2026-09-12
**范围**：Step 3 — `runtime_status` 前端消费 + Runtime 失败分级策略 + session 元数据
**约束遵守**：未新增工具；未修改权限；未进入 Developer/DevOps 能力扩展
**前置**：`docs/stage2-sse-wiring-report.md`

---

## 1. 修改文件

| # | 文件 | 动作 | 对应任务 |
|---|---|---|---|
| 1 | `src/lib/agent/request-class.ts` | **新建** | 任务 2（请求分类） |
| 2 | `tests/runtime-status-contract.test.ts` | **新建** | 任务 2（分类测试 7 项） |
| 3 | `tests/runtime-fallback-policy.test.ts` | **新建** | 任务 2/3 结构护栏（7 项） |
| 4 | `src/app/api/agent/chat/route.ts` | 修改 | 任务 2（分级降级）+ 任务 3（元数据） |
| 5 | `src/lib/agent/stream-events.ts` | 修改 | 导出 `AgentRuntimeMode` |
| 6 | `src/components/agent/status-strip.tsx` | 修改 | 任务 1（`RuntimeBadge`） |
| 7 | `src/app/[locale]/agent/page.tsx` | 修改 | 任务 1（`case 'runtime_status'` + 渲染） |
| 8 | `messages/{zh,en,es}.json` | 修改 | 任务 1（三语 `agent.runtime.*`） |
| 9 | `src/storage/database/shared/schema.ts` | 修改 | 任务 3（5 列） |
| 10 | `scripts/migrate-runtime-metadata.sql` | **新建** | 任务 3（幂等 DDL） |

---

## 2. 修改原因与 diff

### 2.1 任务 1 — 前端消费 `runtime_status`

**原因**：Step 2 已发出 `runtime_status`，但 `page.tsx` 没有 `case`，
事件落到 `default` 被忽略（Step 1 报告 B2）。

新增 `RuntimeBadge`（`status-strip.tsx`）—— **三种 mode 三套视觉，始终可见**：

| mode | 图标 | 色调 | 文案 |
|---|---|---|---|
| `roveagent` | Bot | 天蓝 | RoveAgent 运行时 |
| `fallback` | TriangleAlert | 琥珀 | 降级模式 · 工具能力不可用 |
| `unavailable` | AlertTriangle | 红 | 运行时不可用 · 工具任务已拒绝 |

```diff
+            case 'runtime_status':
+              // Step 3 任务 1：Runtime 状态必须对用户可见。
+              // 关键点：`fallback` / `unavailable` 时**保留 pending**，
+              // 不要在这里置 false —— 否则后续 delta 会渲染成一条已完成的消息。
+              patchStreamingMessage((message) => ({
+                ...message,
+                runtimeMode: event.mode,
+                runtimeDetail: event.detail,
+              }));
+              break;
```

```diff
+                {message.runtimeMode && (
+                  <RuntimeBadge mode={message.runtimeMode} detail={message.runtimeDetail} />
+                )}
+
                 {message.error && (
```

三语键（AGENTS.md 陷阱 #6：动态键 `t(mode)` 必须解析到**嵌套对象**）：

```json
"runtime": {
  "roveagent": "RoveAgent 运行时",
  "fallback": "降级模式 · 工具能力不可用",
  "unavailable": "运行时不可用 · 工具任务已拒绝"
}
```

### 2.2 任务 2 — Runtime 失败策略（请求分类）

**原因**：Runtime 挂掉时「该不该用 TS 兜底」取决于**用户要什么**。

TS 兜底路径（`src/lib/agent/tools/index.ts`）只有读业务数据 + 建审批单的工具，
**没有文件/终端/部署/媒体/插件**。工具类请求降级 = **假装做过** ——
这正是「Developer Agent 假响应」的根因。

新增 `src/lib/agent/request-class.ts`（纯函数、确定性、可单测）：

```ts
export type RequestClass = 'chat' | 'tool_execution';
export type ToolIntent = 'file' | 'terminal' | 'process' | 'deploy' | 'media' | 'plugin';

export function classifyRequest(message: string): RequestClassification
```

**取向说明（保守）**：误判代价不对称 ——
把 tool 误判成 chat 会让用户以为文件改了（严重）；把 chat 误判成 tool
只是普通问答无谓失败（体验差但不危险）。因此只匹配**动作意图**，不匹配名词性提及。

`route.ts` 的分流：

```diff
+    const classification = classifyRequest(body.message);
+
     if (roveAgentConfigured()) {
       try { … usedRoveAgent = true; }
       catch (error) {
         if (error instanceof RoveAgentUnavailable) {
-          runtimeStatus = { mode: 'fallback', detail: error.message };
-          console.warn('[agent/chat] roveagent unavailable, fallback to TS agent path:', error.message);
+          runtimeFailureMessage = error.message;
+          // 工具类请求：不降级，标记为 unavailable
+          if (classification.requestClass === 'tool_execution') {
+            runtimeStatus = { mode: 'unavailable', detail: error.message };
+          } else {
+            runtimeStatus = { mode: 'fallback', detail: error.message };
+          }
         } else { throw error; }
       }
+    } else if (classification.requestClass === 'tool_execution') {
+      // 未配置 Runtime 且是工具类请求：同样必须失败，不能假装
+      runtimeStatus = { mode: 'unavailable', detail: 'roveagent runtime not configured' };
+      runtimeFailureMessage = 'roveagent runtime not configured';
     }
```

流内的硬失败分支（**必须有 `return`**）：

```diff
+      if (runtimeStatus.mode === 'unavailable') {
+        emit({ type: 'notice', level: 'warning', code: 'runtime_required_for_tool_task',
+               message: '…需要 RoveAgent Runtime 执行工具（<intent>），但 Runtime 当前不可用。'
+                      + '已拒绝，未做任何降级处理 —— 没有文件被修改。',
+               technical: runtimeFailureMessage ?? undefined });
+        emit({ type: 'error', error: 'RoveAgent Runtime 不可用，工具类请求无法执行',
+               code: 'runtime_unavailable', retryable: true, provider: 'roveagent' });
+        emit({ type: 'done' });
+        return;                     // ← 关键：不得继续走 TS 兜底
+      }
```

### 2.3 任务 3 — session runtime 元数据

**原因**：改造前，「这条回答是 RoveAgent 出的还是 TS 降级出的」在数据层**无从查证**。

`schema.ts` 新增 5 列 + `scripts/migrate-runtime-metadata.sql`（全部
`ADD COLUMN IF NOT EXISTS`，幂等；列可空无默认值，历史会话保持 `NULL`
表示「迁移前无记录」，不伪装成 `roveagent`）。

**容错设计（重要）**：本机无 DB 凭据，**无法应用 DDL**。
若直接 UPDATE 新列，目标库未迁移时会因列不存在而**整体失败**，
连带把正常的 `updated_at` 更新也一起丢掉。因此：

```diff
+        const withMeta = await updateWithScope(scopedContext, 'chat_sessions', activeSessionId, {
+          ...baseUpdate, ...runtimeMetadata,
+        }).eq('user_id', ctx.userId);
+        if (withMeta.error) {
+          console.warn('[agent/chat] runtime metadata columns unavailable; run scripts/migrate-runtime-metadata.sql:', withMeta.error.message);
+          const fallbackUpdate = await updateWithScope(scopedContext, 'chat_sessions', activeSessionId, baseUpdate)
+            .eq('user_id', ctx.userId);
+          if (fallbackUpdate.error) throw new Error(fallbackUpdate.error.message);
+        }
```

即：**未迁移也能正常工作**，只是没有元数据，并留下一条 warn。

---

## 3. 测试命令

```bash
# 任务 2：请求分类（纯逻辑）
pnpm exec tsx --test tests/runtime-status-contract.test.ts

# 任务 2/3：结构护栏（硬失败 return、分类顺序、元数据写入与回退）
pnpm exec tsx --test tests/runtime-fallback-policy.test.ts

# 全量回归
python -m pytest roveagent/api/stream_wire_test.py roveagent/api/toolsets_test.py \
    roveagent/tools/permissions_policy_test.py -q
pnpm exec tsx --test tests/runtime-status-contract.test.ts tests/runtime-fallback-policy.test.ts \
    tests/roveagent-stream-contract.test.ts tests/roveagent-core.test.ts \
    tests/agent-workspace-21.test.ts tests/personas.test.ts
pnpm exec tsc -p tsconfig.json --noEmit
node scripts/verify-migrations.mjs

# 端到端（需先起 Mock + 内核）
curl -s -N -X POST http://127.0.0.1:8788/api/agent/chat/stream \
  -H "Content-Type: application/json" -H "X-RoveAgent-Key: <key>" -d @payload.json
```

---

## 4. 测试结果

### 4.1 请求分类（任务 2，7/7）

```
$ pnpm exec tsx --test tests/runtime-status-contract.test.ts
✔ 明确的工具动作被判为 tool_execution   （17 个中英样例）
✔ 普通问答判为 chat                     （9 个样例）
✔ 分类是确定性的
✔ 空输入与空白输入判为 chat
✔ 命中片段被记录（供审计），且长度受限
✔ chat 分类不带 intent / matched
✔ 源码文件名会被识别为 file 意图
ℹ tests 7  pass 7  fail 0
```

### 4.2 结构护栏（任务 2/3，7/7）

```
$ pnpm exec tsx --test tests/runtime-fallback-policy.test.ts
✔ 工具类请求 + Runtime 不可用 ⇒ 硬失败（unavailable 分支必须 return）
✔ 分类在 Runtime 调用之前完成
✔ chat 类请求仍允许 fallback
✔ runtime_status 事件在流最开始发出
✔ session runtime 元数据被写入且带降级容错
✔ 迁移脚本存在且幂等
✔ schema.ts 已声明 runtime 元数据列
ℹ tests 7  pass 7  fail 0
```

### 4.3 全量回归

```
$ python -m pytest (3 套)            →  58 passed, 72 subtests
$ pnpm exec tsx --test (6 套)         →  78 tests, 0 fail
$ pnpm exec tsc --noEmit             →  exit 0
$ node scripts/verify-migrations.mjs →  迁移事实源比对通过：schema 51 张表全部覆盖
```

### 4.4 测试 1 与测试 4（端到端事件序列）—— **实测**

```
$ curl -s -N … /api/agent/chat/stream  (agent=developer, "please read the README file")
HTTP 200

Count 事件
  1   runtime_status {mode: roveagent, detail: agent=developer}
  1   status: thinking
  1   status: calling_tool (read_file)
  1   status: tool_done (read_file)
 11   delta
  1   done
```

**你的测试 1（roveagent 正常 → 显示 Runtime 状态）与测试 4（runtime_status /
delta / status / done 完整通过）：实测通过。**

### 4.5 测试 2 与测试 3 —— **未能在本机实测（必须说明）**

| 测试 | 内容 | 状态 |
|---|---|---|
| 2 | Runtime 关闭 + 普通聊天 → fallback 成功 | **未实测** |
| 3 | Runtime 关闭 + developer/file 任务 → 失败 | **未实测** |

原因：这两项需要一个**运行中的 Next.js 应用**（要 Supabase 凭据 + 登录态），
本机无 `.env`，无法启动 `/api/agent/chat` 路由。我已停掉内核确认
「Runtime 关闭」这个前提成立，但无法驱动 TS 路由本身。

**目前覆盖它们的是**：分类单元测试（判定正确）+ 结构护栏（`unavailable` 分支
必须 emit error 并 `return`）。这两者能防住「逻辑写错/被删」，但**不等于运行时验证**。

我没有把这两项填成通过。要真正跑通，需要你提供可用 `.env`（或在一个
已配置的环境执行）。

---

## 5. 下一阶段风险

| # | 风险 | 说明 | 缓解 |
|---|---|---|---|
| R1 | **迁移未应用** | 元数据列不存在时走回退分支，功能正常但审计缺失 | 执行 `scripts/migrate-runtime-metadata.sql`；日志会 warn |
| R2 | **分类误判** | 把 chat 误判成 tool 会让普通问答失败。已尽量保守，但中文表达多样 | 可加「用户可见的『这是问答』纠正入口」；或按 `intent` 白名单逐步放宽 |
| R3 | **`runtime_status` 徽标常驻** | 每条消息都带徽标，可能视觉噪音 | 若确认吵，可只在 `mode !== 'roveagent'` 时显示 |
| R4 | **硬失败无重试引导** | `unavailable` 时用户只看到错误，没有「重试」按钮 | `error` 事件已带 `retryable: true`，`ProviderAlert` 已有 Retry 通道，可接线 |
| R5 | **Step 2 遗留未验证项** | TS→浏览器整段仍未经运行时验证 | 需要可运行环境 |
| R6 | **owner 可自批 MANAGER 动作** | Step 1.5 记录的既有语义，尚未决定是否收紧 | Stage 2 议题 |
| R7 | **`runtime_agent` 语义** | 记录的是 `PERSONA_EMPLOYEE[personaKey]` 映射后的 key，与 Python 侧 `emp.key` 一致；若两边映射表漂移会不一致 | 已有 `emp.key` 归一测试（Step 1.75 探针） |
| R8 | **元数据只存最近一轮** | 同一 session 多轮会互相覆盖，不是历史流水 | 若需完整审计，应写入既有的 `audit_events` 表（本次未做，避免扩大范围） |

---

## 6. 决策记录

**为什么元数据用「覆盖式」而不是流水式**：`chat_sessions` 一行对应一个会话，
放「最近一轮」的 runtime 信息语义清晰、查询简单（`WHERE runtime_mode='fallback'`
即可找出所有发生过降级的会话）。完整的历史流水属于审计表职责，
本次按你的「不要扩大范围」要求未做，已登记为 R8。
