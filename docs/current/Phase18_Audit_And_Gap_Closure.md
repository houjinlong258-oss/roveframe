# Phase 18 审计 — 补齐"没完善的"

本文件是对 Phase 18 交付的**逐项审计**，以及审计中发现并修掉的问题。

方法：不靠印象，先跑命令找出真实缺口，再逐项修，每项都要有能失败的负向对照。
所有数字来自本次实测。无法测量者写 UNVERIFIED。

判定沿用四层口径：**L1 代码存在 → L2 测试通过 → L3 真实调用 → L4 生产可用**。

---

## 1. 一句话结论

审计找到 **6 个实质缺口**，其中 3 个是"代码里有、守卫从未看过"的盲区，
1 个是安全默认值的缺口，1 个是会把故障藏起来的静默兜底，1 个是"声明了却没人读"
的字段。全部已修并配负向对照。

最严重的一条：**`/api/admin/*` 的授权一致性从未被任何守卫检查过**。而
`proxy.ts` 对 `/api/admin/*` **整体跳过**边界检查 —— 也就是说，任何一个新加的
admin 路由只要忘了包 `adminHandler`，它就是**零层防御**，而不是"少一层"。

---

## 2. 审计发现的缺口（按后果排序）

| # | 缺口 | 后果 | 处置 |
|---|---|---|---|
| 1 | `/api/admin/*` 的授权一致性无守卫 | 新 admin 路由忘了包 `adminHandler` ⇒ 完全开放（proxy 对 admin 整体跳过） | 新增结构守卫 + 真实 401 断言 |
| 2 | `site/authorize` 的证书闸门零测试 | ACME 签发被滥用 / 配额被耗光，真商家签不出证书 | 新增 18 例（含 fail-closed 负向对照） |
| 3 | `claimNotificationOutbox` 静默吞错 | 投递循环**安静空转**，outbox 堆积而日志无一字（同 Phase 15 那个藏了 11 天的缺陷） | 改为抛错 + 守卫 |
| 4 | `demo: true` 声明了却**没人读** | 演示数据与真实经营数据在界面上无法区分；截图会被当成经营事实 | 加显式横幅（三语）+ 守卫 |
| 5 | `customer/export` 零测试引用（PII 导出） | 截断不提示、缺 `excluded`、口令列混入 —— 全都不会报错 | 新增 18 例 |
| 6 | 41/132 路由无任何测试引用 | 见 §4 的分层处置 | 高风险项已补，其余如实记录 |

---

## 3. 逐项证据

### 3.1 `/api/admin/*` 授权一致性（缺口 1）

**先取证**（不靠假设）：9 个 admin 路由里 8 个用 `adminHandler`，1 个例外
（`admin/auth` 是登录入口，不能用它自己的守卫）。

**`adminHandler` 实际做了三件事**（读实现确认，不是看名字）：

```
await requirePlatformAdmin(request, options.roles)   → 守卫
PlatformAuthError  → 401 / PlatformForbiddenError → 403
await writePlatformAudit({...})                      → 每次调用都留审计
```

**新守卫**（`tests/admin-surface-authorization.test.ts`，7 例）：凡在 `admin/` 下
**导出写方法**的路由，必须包 `adminHandler` 或在白名单里；白名单只有 `admin/auth`
一条，且要求它 `verify` 自己解析会话并显式拒绝。

**负向对照**：把 `admin/tenants/route.ts`（有 POST）的 `adminHandler(` 改名为
`notTheGuard(` ⇒ **7 例中 1 例变红**，报 `tenants/route.ts [POST]`；还原后 7/7。

### 3.2 证书签发闸门（缺口 2）

`src/app/api/site/authorize/route.ts` 决定**要不要为本机签一张 Let's Encrypt 证书**
（Caddy `on_demand_tls.ask`）。它的失败方向不对称：

- 过宽 ⇒ 任何把域名解析到本服务器的人都能让本机替他申请证书，**并把签发配额耗光**，
  让真商家签不出来；
- 过窄 ⇒ 商家自带域名打不开 HTTPS。

审计实测：`isHostAuthorizedForCertificate` 与 `normalizeHost` 的测试引用数是 **0**。

**新测试**（`tests/site-certificate-authorization.test.ts`，18 例）覆盖：
`normalizeHost` 的归一化与拒绝形状、路由的四个拒绝方向、响应**空体**（不泄漏
"这个域名是否注册过"）、以及 `catch` 之后必须保持拒绝。

**负向对照**：把 `catch` 里的 `allowed = false` 改成 `true`（fail-open 回归）
⇒ **18 例中 1 例变红**；还原后 18/18。

### 3.3 静默吞错（缺口 3）

`claimNotificationOutbox` 原来是：

```ts
if (error) return [];   // ← 认领失败 = "没有待处理通知"
```

这是本仓库记录过**三次**的形态（`agent/tasks/types.ts:82`、`worker.ts:280`
都留着同样的教训注释；Phase 15 有一条 SQL 缺陷因此隐藏了 11 天）。
这里的后果不是崩溃，是**投递循环安静空转**：outbox 堆着待发通知，
每一 tick 都报告"处理了 0 条"，日志里一个字都没有。

**为什么抛错是对的**：唯一调用方 `dispatchNotificationOutbox` 被
`scheduler.ts:498-502` 的 try/catch 包着，会打
`[scheduler] notification outbox worker failed:` ⇒ 失败变成一条**有据可查的日志**。

**本文件把这个判断写下来了**，避免以后又有人"顺手"加回静默：

> 返回**工作清单**的函数：失败不能静默成空清单（调用方会据此少做事）；
> 返回**统计值**的函数（如 `recoverStaleOutboxItems`）：记日志 + 返回零可以接受。

**负向对照**：改回 `if (error) return []` ⇒ **5 例中 3 例变红**；还原后 5/5。

### 3.4 `demo: true` 没人读（缺口 4）

`/api/dashboard` 的演示分支返回 `demo: true`，页面类型里也声明了 `demo?: boolean`
—— 但**从来没有读过它**。于是演示数据（`Math.round((18 + i * 0.6) * ...)` 编的）
与真实经营数据在界面上**完全一样**。一张截图被当成经营事实传出去，正是 Phase 16
任务 1 修掉的那类问题的另一副面孔。

处置：**不删演示模式**（它是刻意的 E2E / 截图能力，且有双重门控），
而是让看到它的人知道自己在看什么 —— 加一条高对比横幅（`role="status"`、
amber 警示色），三语文案齐备。

**新守卫**（`tests/demo-data-visibility.test.ts`，7 例）：接口带回标记、
页面读它并渲染、横幅是显式的、三语齐备且**互不相同**（防复制粘贴忘了翻译）、
双重门控仍在。

**负向对照**：把 `{isDemoData && (` 改成 `{false && (` ⇒ 断言变红。

### 3.5 顾客数据导出（缺口 5）

`customer/export/route.ts` 的注释**两次点名**它需要被验证：

- 第 111-114 行：「抽成可导出函数是为了它能被**执行**验证 …… 这里做错的地方全都
  不会报错：订单被截断却不置 `orders_truncated`；忘了带 `excluded`」；
- 第 165-166 行：「本文件通篇不出现那两个列名，源码级断言见
  tests/customer-account.test.ts」。

而审计实测：该路由的测试引用数是 **0**，函数被导出但从未被调用。

**新测试**（`tests/customer-export.test.ts`，18 例）：`buildCustomerExport` 的
真实调用（截断边界、`excluded` 两个条目的理由必须说明"为什么"、原样带回入参）、
鉴权前分支（含"查询参数不得绕过会话解析"）、以及那两条源码义务
（口令列名不得出现、订单上限必须与 `/api/customer/orders` 相同、地址列清单必须与
`/api/customer/addresses` 逐字相同）。

---

## 4. 剩余缺口（如实记录，不用"有测试文件了"冒充覆盖）

### 4.1 无测试引用的路由：41/132 → **39/132**

本轮补了 2 条（`site/authorize`、`customer/export`）。剩余 39 条的**分层**判断：

| 类别 | 例子 | 现有保护 | 判断 |
|---|---|---|---|
| 平台管理面 | `admin/usage`、`admin/audit-logs`、`admin/subscriptions` | 本轮新增的结构守卫 + `adminHandler` 的三件事 | 可接受 |
| 顾客/商家会话边界 | `agent/*`、`artifacts/*`、`emails/*`、`knowledge/*`、`marketing/*` | `getTenantContext` + `requirePermission`（中央）+ RBAC 契约 | 可接受 |
| 公开边界 | `site/reservations`、`store/staff` | 各自路由内的守卫；`site/reservations` 有 `verify` 契约 | 可接受 |
| **需要人看一眼** | `onboarding/confirm`（会建 business + settings，且**向导页无导航入口**） | 无 | **见 4.2** |
| **需要人看一眼** | `websites/*`（`/api/website`、`/website/generate`） | 无 | **见 4.2** |

### 4.2 两处仍缺判断的地方（本轮未动，需要产品决策）

1. **`onboarding/confirm`**：它会创建 business + settings + 知识库占位文档，
   而它对应的向导页 `/[locale]/onboarding` **没有任何导航入口**（Phase 16 已记录）。
   本轮未删（禁止无分析删除），也未接进流程。**它现在的状态是"可达但没人知道"**：
   任何知道这个 URL 的人都能给自己的租户再开一个 business —— 这是设计允许的
   （一个租户多门店），但"没有入口"意味着它从未被真的用过，因此也从未被验证过。
2. **`/api/website*`**：这是另一个代理本轮新增的（商家站点生成）。它没有测试引用，
   也没有进 RBAC 契约。**我没有替它加守卫**：我不掌握那部分的设计意图
   （它是公开生成器还是商家后台接口？鉴权边界在哪？）。

### 4.3 仍未验证的层

| 项 | 状态 |
|---|---|
| 定位授权弹窗 / 地图真实渲染 | **UNVERIFIED** —— 需要配了地图服务商的租户 + 真实的浏览器权限授予 |
| 打卡交互的完整流程 | **UNVERIFIED** —— 浏览器端只验到"页面渲染 + 事件被接管" |
| 邀请邮件在真实收件箱中的样子 | **UNVERIFIED** —— 无平台侧 SMTP |
| `customer/export` 与 `account/close` 的**成功路径** | **UNVERIFIED** —— 需要真实顾客会话与库数据 |

### 4.4 环境问题（不是代码问题）

**C: 盘曾只剩 6.74 GB，导致写入 `ENOSPC` 且编辑静默未落盘。**
本轮清理我自己的临时产物（CDP profile、备份文件、构建日志）后回到 **15.2 GB**。

仍占空间的大项（**我没有动，因为可能含你的数据**）：

| 目录 | 大小 | 说明 |
|---|---|---|
| `%LOCALAPPDATA%\Docker\wsl\disk\docker_data.vhdx` | **20.79 GB** | Docker Desktop 虚拟磁盘；daemon 当前没运行，不会自动收缩 |
| `<另一套代理框架的数据目录>` | 3.14 GB | 另一套代理框架的数据 |
| `%LOCALAPPDATA%\Google`（Chrome） | 2.51 GB | 浏览数据 |
| `%LOCALAPPDATA%\com.crow5.desktop` | 2.46 GB | 第三方应用 |
| `%LOCALAPPDATA%\ms-playwright` | 0.67 GB | **本项目不用 Playwright**（本轮的浏览器验证零依赖自建） |

---

## 5. 本轮新增的守卫与它们的负向对照

| 文件 | 例数 | 负向对照 | 结果 |
|---|---|---|---|
| `tests/admin-surface-authorization.test.ts` | 7 | 去掉 `admin/tenants` 的 `adminHandler` | **1 例变红**（报 `tenants/route.ts [POST]`） |
| `tests/site-certificate-authorization.test.ts` | 18 | `catch` 里改成 `allowed = true` | **1 例变红** |
| `tests/notification-claim-visible.test.ts` | 5 | 改回 `if (error) return []` | **3 例变红** |
| `tests/demo-data-visibility.test.ts` | 7 | 横幅条件改成 `false` | 断言变红 |
| `tests/customer-export.test.ts` | 18 | 见文件内的合成反例 | 通过 |

### 5.1 一次**注入失败**（本轮第二次，值得单独记）

对"admin 守卫"做负向对照时，我第一次选了 `admin/usage` 作为注入目标。
注入确实生效（`adminHandler(` 出现次数 1 → 0），但**测试仍然全绿**。

差点据此判定"守卫无效"。查下去发现是**注入选错了目标**：

```
usage\route.ts   methods=[GET]   writes=[]   handler=true
```

`admin/usage` **只有 GET**，而那条守卫检查的是**写方法** —— 它本该跳过这个文件。
改用有 POST 的 `admin/tenants` 后立刻变红。

这与 Phase 18 正文记录过的另一次同类事件（用 `node -e` 注入 compose 时引号转义
坏掉、脚本抛 SyntaxError 而测试全绿）是**同一个陷阱**：

> **看到"注入后仍然全绿"时，第一件要查的是注入是否真的作用在被检查的对象上，
> 而不是先怀疑守卫。**

---

## 6. 审计用到的工具（新增）

| 脚本 | 用途 |
|---|---|
| `scripts/_browser_check.mjs` | 零依赖 CDP 浏览器验证（Phase 18 主轮新增；本轮用它复验 14 个路由全部 PASS） |
| `scripts/_scan_i18n_keys.mjs` | i18n 键扫描：源码 `t('key')` × messages，含三语一致性 |

`_scan_i18n_keys.mjs` 实测结果：**411 个源码文件、880 处字面量键、
确定缺失 0、三语不一致 0**。5 处"待确认"经查是**扫描器的局限**而非缺陷
（`topbar.tsx` 有两个翻译函数：`t = useTranslations()` 无命名空间
+ `ta = useTranslations('account')`，而扫描器只按声明过的命名空间查）。

---

## 7. 回归结果

| 项 | 值 |
|---|---|
| Python | **Ran 815 tests / OK**（本轮未改 Python；`run-python-tests.py` 本次输出**未打印跳过数**，因此跳过数记 UNVERIFIED —— 此前几轮为 4） |
| TypeScript | **1373 用例 / 1372 pass / 1 skip / 0 fail**（审计前 1299，**+74**） |
| `pnpm validate` | **exit 0**（生产扫描 2462 文件） |
| `pnpm next build` | **exit 0** |
| 浏览器验证 | **14/14 路由 PASS**（console error 0 / 未捕获异常 0 / 失败请求 0） |
| i18n 扫描 | 确定缺失 **0**，三语不一致 **0** |
| 迁移事实源 | **52/52 张表**全部覆盖，唯一索引口径一致 |
| C: 剩余空间 | 6.74 GB → **15.2 GB** |

---

## 8. 我否定了自己什么

| 我的判断 | 实测 | 更正 |
|---|---|---|
| `normalizeHost('shop.example.com:80/path')` 必须被拒 | 它是 `split(':')[0]` ⇒ 先切端口，`/path` 一起被切掉 ⇒ 返回合法域名 | 期望写错，已拆成两条准确断言 |
| 路由测试传 `Request` 就够 | 路由读 `request.nextUrl`（**NextRequest 专有**）⇒ 6 例全红 | 夹具类型用错，不是实现有问题 |
| `customer/export` 该登记进 RBAC 契约白名单 | 它只导出 **GET**，而那份契约查的是**写方法** | `ts-check` 直接拒绝：`'GET' is not assignable to type 'MutationMethod'`。删掉登记，把"未登记是对的"写进测试 |
| `admin/usage` 可以当负向对照的注入目标 | 它只有 GET，守卫本该跳过它 | **注入无效**，见 §5.1 |

---

## 9. 一句话

审计的价值不在"又加了 74 个用例"，而在**找出了三处从未被任何守卫看过的边界**
（admin 授权一致性、证书签发闸门、PII 导出），以及一处会把故障藏起来的静默兜底。

其中 admin 那条最值得记住：它不是因为"proxy 少了一层"而危险，
而是因为**任何新路由都可能是一层都没有**，而这种缺口靠读代码盯不出来 ——
只能用结构守卫钉住。
