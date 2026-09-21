# Phase 18 交接提示词 —— 三端 PWA、配送、员工与账号体系

把这整份粘给新会话。它是自包含的：新会话看不到之前的对话。

---

## 0. 你的角色与这份文档的用法

你是这个仓库的工程师。**先读 `AGENTS.md`**（项目陷阱清单），再读本文。
本文给的是：当前真实状态、在飞的工作、已知缺陷、以及**必须遵守的纪律**。

最重要的一条：**任何"完成/通过/干净"的结论都必须先有一个能产生"不通过"的负向对照。**
没有负向对照的断言等于没断言 —— 这个仓库已经因此翻车过五次（见 §7）。

---

## 1. 项目与技术栈

- 路径：`D:\RoveFrame AI Business OS\RoveFrame AI Business OS\roveframe-src-latest`
- Next.js 16（App Router）+ TypeScript strict + React 19 + Tailwind 4 + shadcn/ui + next-intl（en/zh/es，**三语必须同步**）
- 自定义服务端入口 `src/server.ts`（tsup → `dist/server.js`）+ Python FastAPI RoveAgent 运行时
- 数据层是 Supabase（PostgREST + GoTrue + Storage），全部走 `service_role`，客户端只有一个 `createClient` 且无 `'use client'`
- **零新增依赖**（只能用 pnpm 与 Node 内置）。**禁止 `pnpm add`。**

## 2. 当前已落地且**已验证**的东西

最近两个提交：
- `4e321b7` — Phase 17/18 主体：三端 PWA、配送、员工、内置部署链
- `1f12f67` — 员工端可用性验证（真账号 + 真会话）

实测数字（都是真跑出来的，不是推断）：

| 项 | 结果 |
|---|---|
| 迁移链 | **18/18 应用到真实库**，且在已有对象的库上重跑成功（证明幂等） |
| 数据库 | `missingCount: 0`，10 张新表 / 8 个列 / 6 个索引实测存在 |
| 全量闸门 | `pnpm validate` exit 0（1176 测试 / 0 失败 / 生产扫描 2424 文件） |
| HTTP 边界 | **12/12**：公开路径能进 handler、受保护路径 401 |
| 真实数据流 | **10/10**，含"SSR 出的 HTML 里含真实商品名" |
| 员工端全链路 | **15/15**：真登录 cookie → `/api/staff/me` → 排班 → 考勤 → 打卡 → 导出 |
| 外卖全链路 | **66/66**：下单 → 幂等重放 → 起送价拦截 → 认单 → 竞态 409 → 状态推进 → 位置上报 → ETA → 越权拒绝 |
| 注册回滚 | **7/7**：已注册邮箱 409 + **零副作用** |
| 指纹长度 | **6/6**（含"旧实现必须超宽"的负向对照） |

## 3. 在飞的工作 —— **先确认它们落地了没有**

我派了 3 个子代理，你可能接手时它们已完成或未完成。**先查，不要假设**：

```powershell
git status --porcelain
```

按这些落点核对：

| 代理 | 应当产出的文件 |
|---|---|
| 接线 | `src/components/layout/topbar.tsx`（账号菜单 + 退出登录）、`sidebar.tsx`（加 `/team`）、`settings/page.tsx`（加 account 分组）、`auth/login/page.tsx`（员工/老板双入口）、`messages/*.json`、`tests/account-wiring.test.ts` |
| 员工功能开关 + 地图 | `src/lib/staff-access.ts`、`src/app/api/team/staff-access/route.ts`、`src/components/delivery/delivery-map.tsx`、`tests/staff-access.test.ts` |
| 顾客账号管理 | `src/app/api/customer/me/route.ts`（加 PATCH）、`customer/auth/change-password/`、`customer/export/`、`customer/account/close/`、`customer/addresses/route.ts`（加 PATCH）、`tests/customer-account.test.ts` |

**注意**：我最后看到的 `pnpm ts-check` 报了 2 处错误，都在顾客账号代理的在飞文件里
（`customer/addresses/route.ts:166 clearOtherDefaults` 未定义、
`customer/export/route.ts:240` 类型收窄）。若它们还在，那说明该代理没做完。

### 已经替它们做掉的事（不要重复做）

- `tests/api-rbac-contract.test.ts` 已登记 4 条顾客端白名单：`customer/me`(PATCH)、
  `customer/addresses`(POST/DELETE/**PATCH**)、`customer/auth/change-password`(POST)、
  `customer/account/close`(POST)。verify 断言 handler 内真的解析了顾客会话并显式拒绝。
  **不要**允许任何代理用 `export { handler as PATCH }` 绕开这个守卫 —— 那是绕过。

## 4. 已知缺陷与待办（按优先级）

### 4.1 必须修：`dest_lat` / `dest_lng` 只有读、没有写（ETA 不可达）

`delivery_orders.dest_lat`/`dest_lng` 是我加的列，注释里写"唯一诚实来源是顾客下单时
本人设备的定位"—— **但那条写入路径我没实现**。而且全仓 grep 显示
`src/components/delivery/delivery-tracker.tsx` 与顾客端 PWA **都没有调用**
`GET /api/store/deliveries/{id}/track`。

后果：`estimate` 恒为 null，顾客永远看不到 ETA，整条追踪接口在产品里不可达。

要做的：
1. `POST /api/store/delivery-orders` 接收可选的 `lat`/`lng`（顾客设备定位，需顾客显式授权），写入 `dest_lat`/`dest_lng`
2. 顾客端在结算时请求 `navigator.geolocation`，**失败或拒绝就不传**，不要编坐标
3. 把 `delivery-tracker` 接上 `/api/store/deliveries/{id}/track`，并把坐标交给地图组件

### 4.2 小修：注释与 cookie 名不符

`scripts/_verify_staff_tier.mjs:15` 注释写 cookie 名 `roveframe_session`，
实际是 `rf_session`（`src/lib/auth.ts:18`）。

### 4.3 收尾项（我问过、用户未表态）

| 项 | 现状 |
|---|---|
| 邀请链路 | `POST /auth/v1/invite` 在无 SMTP 的项目上实测 **429**；`generateLink` 可用但邮件要我们自己发。**未决定**。`/api/team/invite` 已按"任一步失败即明确报错"实现 |
| `ROVEFRAME_COMMAND_POLICY` | 全仓 **0 引用**（Phase 16 就标为高风险） |
| `RF_E2E_DEMO` 分支 | `src/app/api/dashboard/route.ts:209-227` 仍会**编造整套仪表盘**（`Math.round((18 + i*0.6) * ...)`）。开关置真则商家看到假数据 |
| `/{locale}/staff/login` | 规格里是独立路由，实际登录界面内嵌在组件里 |
| `/team` 入口 | 若接线代理未完成，侧边栏仍无它 |
| 两个探测账号 | `auth.users` 里剩 `probe-*@example.invalid`、`verify-*@example.invalid`。惰性无害；直删 `auth.users` 会牵动 GoTrue 关联表，风险大于收益 |

### 4.4 完全未验证：浏览器端运行时

hydration、15 秒轮询、打卡交互、接单 409 的实际提示、隐私开关、导出下载、
地图渲染、账号菜单 —— **全部只有 SSR 与源码级证据**。要有真浏览器才算过。

## 5. 环境与运行方式（踩过的坑都在这里）

### 数据库（DDL 需要）

```
PGHOST=aws-0-us-east-1.pooler.supabase.com
PGUSER=postgres.omoyrubbsjquadopbjoo
PGDATABASE=postgres
PGPASSWORD=<用户提供；密码不落盘，向用户要>
```

- **直连 `db.<ref>.supabase.co` 在这台机器上不通**（`Connection terminated unexpectedly`，
  它是 IPv6-only）。**必须走 Session pooler**，host 是 `aws-` 开头。
- `aws-1-*` / `aws-0-us-west-1-*` 都不通（`tenant/user not found`）。
- **不要把密码写进任何文件。**

### 起服务

Docker 容器在这台机器上**出不了 TLS**（实测：DNS 通、TCP 通、TLS 被中间设备断、
明文 HTTP 被返回 500），所以**不要用容器**，用原生进程：

```powershell
# 环境在同一个命令里加载（新 pwsh 进程不继承）
Get-Content docker\deploy.env | Where-Object { $_ -match '^\s*[A-Z_]+\s*=' -and $_ -notmatch '^\s*#' } | ForEach-Object {
  $i = $_.IndexOf('='); $k = $_.Substring(0,$i).Trim(); $v = $_.Substring($i+1).Trim()
  [System.Environment]::SetEnvironmentVariable($k, $v, 'Process')
}
$env:COZE_PROJECT_ENV='PROD'
npx next start -p 5067      # 用后台任务跑
```

- **用 `next start`，不要用 `dist/server.js`** —— 后者会因为父目录也有 `pnpm-lock.yaml`
  而在 Next 的工作区根推断上卡住，端口一直不监听。
- 改了代码必须先 `npx next build` 再重启，否则测的是旧构建。

### 已种下的演示数据（可直接用）

| 用途 | 值 |
|---|---|
| 租户 / 商家锚点 | `00000000-0000-0000-0000-000000000000` / `...0001` |
| 官网 slug | `demo-bistro`（已发布，含 WEB 网页桌号） |
| 员工账号 | `staff.demo@roveframe.local` / `Staff-demo-2026`（role=staff，已关联档案） |
| 外卖 | `settings.delivery = {enabled:true,minOrderAmount:20,fee:3,freeDeliveryAbove:50,prepMinutes:35}` |

清理：`npx tsx scripts/_seed_demo_staff.mts --cleanup`、
`npx tsx scripts/_seed_demo_delivery.mts --cleanup`、
`npx tsx scripts/_cleanup_probe_tenants.mts`

## 6. 现成的验证工具（复用它，别重造）

| 脚本 | 干什么 |
|---|---|
| `scripts/_apply_all_migrations.mts` | 按 `MIGRATION_FILES` 顺序跑整条链，一文件一事务，逐文件报时 |
| `scripts/_probe_p18_state.mts` | 只读探测表/列/索引/数据量 |
| `scripts/_fix_migrate_idempotency.mjs` | 扫描并修补非幂等 DDL，`--check` 可复检 |
| `scripts/_verify_p18_http.mjs` | 12 条边界检查（公开可达 + 受保护拒绝，两个方向都要对） |
| `scripts/_verify_p18_dataflow.mjs` | 10 条真实数据流检查（含 HTML 里含真实商品名） |
| `scripts/_verify_staff_tier.mjs` | 15 条员工端全链路（真登录 cookie） |
| `scripts/_verify_delivery_chain.mjs` | 66 条外卖全链路 |
| `scripts/_verify_signup_rollback.mjs` | 7 条注册回滚（含"副作用为零"） |
| `.cache/probe-appshell-bypass.mjs` | 从源码**枚举**旁路并逐个求值（不硬编码名单） |

## 7. 纪律（非协商，每条都有翻车实例）

1. **先验证再修改。** 本项目已四次因这条救回决策：`agent_build 4 秒瓶颈` 实测是
   SSL 校验 780ms、`gateway/` 号称死代码实有 33 个导入方、静态可达性工具对
   `business_data_tool` 有假阴性、我自己写的"app-shell 已旁路 /staff"实测没有。
2. **任何"通过"结论都要有能失败的负向对照。** 本会话我自己写的测试就有三条
   把正确代码判成错（锚点被 `stripComments` 剥掉、切片区间取反、
   `s` 正则标志在 ES2017 下报 TS1501）。
3. **会撒谎的探针比没有探针更糟。** 一个在改动之后仍输出旧结论的探针
   （名字硬编码的旁路探针）就是恒假的红灯。
4. **禁止**：删除未知代码（除非先做真正的可达性分析）、重构大模块、
   新增重复架构、新增依赖、静默 fallback（宁可 fail-closed 报错）。
5. **注释写中文，解释 why 不是 what。**
6. **更正先前结论时必须用 `<details>` 保留原文**，不留"当时说得很严重、后来悄悄改掉"的痕迹。
7. **报告写法**：平实、精确、陈述式、短句、表格优先、不用 emoji、不夸大；
   无法测量写 **UNVERIFIED**，不要用推断代替证据。

## 8. 这个环境里的具体陷阱（我踩过的，省你时间）

| 陷阱 | 应对 |
|---|---|
| PowerShell 吞掉 `node -e` / `tsx -e` 里的引号 | **写成脚本文件再跑**，不要跟引号搏斗 |
| `Select-String -Path "src\**\*.ts"` 的通配不可靠 | 用 `grep` 工具（ripgrep） |
| 模板字符串里出现反引号会提前闭合 | 注释移到 SQL 字符串**外面** |
| `ON CONFLICT` 对**部分**唯一索引无效 | 必须重复它的谓词：`on conflict (user_id) where user_id is not null` |
| `auth.users` 的列叫 `raw_app_meta_data` | 不是 `app_metadata` |
| `staff` 表**没有** `updated_at` | 别在 upsert 里写它 |
| `job_kill` 杀不掉子 node 进程 | 端口会一直被占；要显式 `Stop-Process` |
| 批量 `Stop-Process node` 会杀掉**正在跑的服务** | 我因此中断过一次用户的测试，先确认再杀 |
| 登录限流是**内存态 + 15 分钟自锁**，一次错密码会让该邮箱**与该 IP** 连正确密码都 429 | 验证脚本每次用不同的 `X-Forwarded-For`（`getClientIp` 先读它，`src/lib/rate-limit.ts:176`） |
| `pnpm validate` 含 stylelint，而 `pwa-tier.css` 是搬运来的第三方样式（600+ 风格问题） | 它已在 `stylelint.config.mjs` 的 `ignoreFiles` 里，**这是刻意决定**：逐条改会让该文件无法再被脚本重复生成 |
| `pnpm validate` 会同时跑迁移比对 / ts-check / eslint / stylelint / 全量测试 / 生产扫描 | 它绿了才算绿；但**注册守卫**（`api-rbac-contract`）要求新写接口要么走中央守卫要么登记白名单 |

## 9. 完成度必须分四层

| 层 | 判定 |
|---|---|
| 1 代码存在 | `pnpm ts-check` exit 0 |
| 2 测试通过 | `pnpm test` 全绿，且新守卫**有能失败的负向对照** |
| 3 真实调用 | 起服务、带真会话、打真 HTTP，看真响应体 |
| 4 生产可用 | 数据真的落库、边界真的拒绝、浏览器里真的能用 |

**第 3 层以下不算完成。** 本会话前半段所有断言都停在 1-2 层，是补上 3-4 层之后才发现
了三个真缺陷（指纹超宽导致下单 500、`settings.wellbeing` 没有迁移、注册不留回滚）。

## 10. 建议的执行顺序

1. `git status` 核对 §3 的落点，确认三个代理做到哪一步
2. `pnpm validate` 拿到基线；把它当"之后变红就是自己引入的"
3. 修 §4.1（`dest_lat` 写入 + 追踪接口接线）—— 这是唯一挡着功能可用的缺陷
4. 修 §4.2 的小笔误
5. 跑 §6 的全部验证脚本，全部要有负向对照
6. **提交**（`4e321b7` 之后的工作区一度有 167 个文件未提交，风险很高）
7. 剩下的按 §4.3 逐条问用户，**不要自己替他决定**

## 11. 一句话总结现状

代码与迁移都到位且验证过；**缺的是"从结构完成到真的能用"那一层**——
外卖与员工两条线已有真实数据与真实会话验证，但浏览器端运行时、地图渲染、
账号体系的界面，都还只有 SSR 与源码级证据。
