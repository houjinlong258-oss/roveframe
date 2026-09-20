# Phase 18 前端施工规格 —— 三端 PWA

面向：负责 PWA UI/前端的人。
配套：`docs/current/Phase18_Construction_Blueprint.md`（后端与 DDL 图纸）。
状态：**接口契约已定，后端尚未实现。** 见 §1。

---

## 1. 交付边界（先确认这条，避免返工）

| 归属 | 内容 |
|---|---|
| **前端（你）** | 页面、组件、交互、状态、i18n 文案、PWA manifest 的消费、样式 |
| **后端（我）** | 数据库迁移、API 路由、权限判定、并发安全、i18n 命名空间占位与 parity 守卫 |

**关键前提**：本文档 §7 列出的接口**目前都还不存在**。它们是我要按契约实现的。
你可以现在就按契约开发（用 mock 或本地假数据），我保证实现的路径、字段名、
状态码与本文档逐字一致。**如果实现时发现契约要改，我会先改这份文档再改代码**，
不会让你对着漂移的接口返工。

**已经存在、可以直接对接的**（Phase 17，代码已落地）：

| 接口 | 状态 |
|---|---|
| `GET /api/store/menu?token=` | 已存在 |
| `POST /api/store/orders` | 已存在 |
| `GET /api/store/staff?token=` | 已存在 |
| `POST /api/site/reservations` | 已存在（Phase 17 新增） |
| `GET /api/website` · `PATCH /api/website` · `POST /api/website/generate` | 已存在（Phase 17 新增，老板端官网页在用） |

---

## 2. 三个 PWA 入口

同一个域名下装三个 App，靠 manifest 的 **`id`** 区分（不是 `scope`——`id` 才是身份）。

| | 顾客端 | 员工端 | 老板端 |
|---|---|---|---|
| manifest URL | `/{locale}/site/{slug}/manifest.webmanifest` | `/{locale}/staff/manifest.webmanifest` | `/manifest.webmanifest`（已存在） |
| `id` | `/{locale}/site/{slug}/` | `/{locale}/staff/` | `/` |
| `scope` | `/{locale}/site/{slug}/` | `/{locale}/staff/` | `/` |
| `start_url` | `/{locale}/site/{slug}/order` | `/{locale}/staff/today` | `/dashboard` |
| 名称 | 商家名称 | `{商家名称} Staff` | RoveFrame |
| 图标 | 商家 logo（≥512×512），缺失时**显式**回落平台图标 | 平台图标 | 平台图标（已存在） |
| 主题色 | 商家 `public_sites.theme.primary` | 平台主色 | 平台主色 |
| 显示 | `standalone`，`orientation: portrait` | `standalone`，`portrait` | `standalone` |

**注意**：`locale` 与 `slug` 是**运行时才知道**的值，manifest 是动态路由生成的，
不能在 `src/app/manifest.ts` 里写死。前端只需在页面 `<head>` 里引用正确的 URL——
用 Next 的 `metadata.manifest` 字段，**不要手写 `<link>` 标签**（AGENTS.md 禁止 `<head>` 标签）。

安装引导不重写：`src/components/pwa/InstallPrompt.tsx` 已经处理了
Android `beforeinstallprompt` 与 iOS Safari 手动引导两条路径，直接复用。
三个入口各自挂一次即可。

---

## 3. 路由清单

### 3.1 顾客端 `/{locale}/site/{slug}/`

| 路由 | 页面 | 说明 |
|---|---|---|
| `/order` | 点餐主界面（PWA `start_url`） | 四个模式切换，见 §4 |
| `/booking` | 预约 | 也可不单独成页，作为 `/order` 的一个模式 |
| `/` | 商家首页 | 复用 Phase 17 的公开官网页，已有 |

老路径 `/{locale}/store?token=` **必须保持可用**（老二维码、老链接），
它渲染与 `/order` 完全相同的内容。

### 3.2 员工端 `/{locale}/staff/`

| 路由 | 页面 | 进得去的前提 |
|---|---|---|
| `/login` | 员工登录 | 未登录 |
| `/today` | 今日（`start_url`） | 已登录 |
| `/clock` | 打卡 | 已登录 |
| `/shifts` | 我的排班 | 已登录 |
| `/deliveries` | 外卖派单 | 已登录 |
| `/reservations` | 预约确认 | 已登录 |
| `/me` | 我的（资料 / 隐私开关 / 关怀资源） | 已登录 |

员工端**不复用** `AppShell`。它需要自己的外壳（底部导航、移动优先），
放在 `src/components/staff/staff-shell.tsx`。
`src/components/layout/app-shell.tsx` 里需要加 `/staff` 的旁路（这部分我来改，
因为它是共享组件，你和老板端都会受影响）。

### 3.3 老板端（现有 SaaS，不是重做）

| 路由 | 说明 |
|---|---|
| `/{locale}/team` | 员工管理：档案 / 排班 / 考勤 三个 Tab |
| `/{locale}/team/care` | 员工关怀：AI 待办 / 关怀记录 / 资源 |
| `/{locale}/website` | 官网（Phase 17 已实现，可参考它的写法） |

老板端加入口在 `src/components/layout/sidebar.tsx` 的 `operations` 分组。
`/team` 与员工端的 `/staff` 是**两个不同的路径**，刻意分开：
前者是管理界面，后者是员工自己的 App，scope 不能重叠。

---

## 4. 顾客端 PWA 规格

### 4.1 四个模式

顶部或底部一个模式切换：**点单 / 外卖 / 预定 / 菜单**。

模式状态放 URL query（`?mode=dine_in|delivery|booking|menu`），不要只放组件 state。
理由：可分享、可后退、PWA 冷启动能直达。

| 模式 | 内容 | 提交后 |
|---|---|---|
| 点单（堂食） | 现有菜单 + 桌号（来自 token） | 走现有 `POST /api/store/orders` |
| 外卖 | 菜单 + 地址表单 + 配送费/起送价 | `POST /api/store/delivery-orders` |
| 预定 | 日期时间 / 人数 / 姓名 / 电话 | `POST /api/site/reservations` |
| 菜单 | 只读浏览，无购物车 | — |

**已有的不要重做**：购物车、小费、备注、落单、幂等键、员工小费打赏、
商品详情弹窗都在 `src/app/[locale]/store/page.tsx` 里且已完成。
本次是把它**抽成共用组件**并加模式切换，不是重写。抽取后的行为必须逐项不变。

### 4.2 外卖模式的 UI 要求

| 元素 | 规则 |
|---|---|
| 起送价 | 未达起送价时下单按钮**禁用**，并显示还差多少 |
| 配送费 | 由服务端返回，前端只展示；满额免配送费要显示"已免配送费" |
| 配送范围 | 本期不做地图。只校验地址文本非空 + 长度 |
| 预计时间 | `prepMinutes` 来自服务端，展示为"约 X 分钟" |
| 商家未开外卖 | 整个外卖 tab **不显示**（而不是显示后报错） |
| 地址簿 | 已登录顾客可保存地址；未登录只能手填，下单后可提示绑定 |

**金额一律以服务端返回为准。** 前端可以显示小计做参考，但提交时不传金额字段，
响应里的 `subtotal` / `fee` / `total` 才是权威值。这是硬要求，不是建议。

### 4.3 顾客登录

| 项 | 要求 |
|---|---|
| 入口 | 下单页右上角；下单成功后也提示一次 |
| 表单 | 邮箱或手机号 + 密码；注册/登录同一个弹层切换 |
| 登录后 | 订单自动出现在"我的订单"；地址簿可用 |
| 游客 | **必须仍然能下单**（不能因为加了账号就逼人登录） |
| 我的订单 | 列表 + 详情（状态、金额、时间、配送进度） |
| 登出 | 清 cookie |

顾客身份与商家身份是**两套完全独立的东西**：顾客 cookie 名是
`roveframe_customer_session`。**不要**把顾客登录跳到老板端的登录页，反之亦然。

---

## 5. 员工端 PWA 规格

### 5.1 登录页

| 项 | 要求 |
|---|---|
| 与老板端**分开的入口** | 独立 URL `/{locale}/staff/login`，独立视觉（员工端主色不要用老板端那套） |
| 表单 | 邮箱 + 密码。**复用同一个登录接口** `POST /api/auth/login`，不要第二个认证系统 |
| 登录成功 | 按返回的 `role` 决定落地：`staff`/`manager` → `/staff/today`；`owner` → `/dashboard` |
| 账号有效但无员工档案 | 接口返回 **409**，页面显示明确指引："你的账号还没关联员工档案，请联系店长"——不要显示空白或转圈 |
| 记住我 | 可选，用 cookie 有效期控制 |

### 5.2 今日 `/today`

一屏之内要看到：

| 区块 | 内容 | 空态文案 |
|---|---|---|
| 打卡卡 | 当前状态（未打卡 / 已打卡 X 小时）+ 一个大按钮 | — |
| 我的班次 | 今天的时间段与岗位 | "今天没有排班" |
| 待接外卖 | 数量徽标，点击进派单页 | "暂时没有外卖单" |
| 待确认预约 | 数量徽标 | "今天没有待确认的预约" |
| 待办 | 考试/任务类（复用现有 notify） | 隐藏整个区块 |

### 5.3 打卡 `/clock`

| 项 | 要求 |
|---|---|
| 按钮 | 一个按钮。**不传方向**（不传"签到/签退"），服务端判定 |
| 反馈 | 成功后显示"已签到 14:32" / "已签退，本次 7 小时 12 分" |
| 重复点击 | 按钮在请求期间禁用；服务端有幂等保护，重复点不会产生两条记录 |
| 历史 | 近期考勤列表（时间 + 时长），只读 |
| 补卡 | **员工端不提供**。补卡只能由店长在老板端做，且写审计 |
| 定位 | 本期不做。不要请求地理位置权限 |

### 5.4 我的排班 `/shifts`

周视图或列表，显示未来 14 天。每项：日期、时间段、岗位、备注。
**只能看到自己的**——接口层已强制，前端不要提供任何按员工筛选的控件。

### 5.5 外卖派单 `/deliveries`

| 元素 | 要求 |
|---|---|
| 两个分组 | "待接单" 与 "我的配送中" |
| 待接单卡片 | 单号、地址、电话、金额、下单时间、承诺时间、商品摘要 |
| 接单按钮 | 点击 → `POST /api/staff/deliveries/claim` |
| **被别人抢走** | 服务端返回 **409**。UI 必须把该卡片从"待接单"移除并提示"已被其他同事接走"，**不要**显示成普通错误 |
| 我的配送中 | 状态推进按钮：已取餐 → 已送达 |
| 打电话 | `tel:` 链接，移动端直接拨号 |
| 刷新 | 列表需要自动刷新（轮询 15–30 秒即可）；本期不做 WebSocket |

**接单是原子的**：两个员工同时点，只有一个人成功。前端不要"先本地标记再接单"，
必须以服务端响应为准。

### 5.6 预约确认 `/reservations`

按日期分组的列表：时间、人数、姓名、电话、状态。
操作：确认 / 标记到店 / 取消。状态：`pending → confirmed → arrived`，
或 `cancelled`。

### 5.7 我的 `/me`

| 区块 | 内容 |
|---|---|
| 资料 | 姓名、岗位、入职日期（只读；要改找店长） |
| 隐私开关 | "允许记录我的生日等个性化信息" —— **默认关闭**，由员工本人开启 |
| 数据导出 | 下载自己的档案 + 考勤 + 关怀记录（JSON） |
| 关怀资源 | 心理支持资源列表（热线、自助材料）。**只做资源转介** |
| 登出 | — |

**关怀资源页不要做任何测评、问卷、情绪打分。** 这是硬约束，见蓝图 §8.3。

---

## 6. 老板端新增页规格

### 6.1 `/{locale}/team`

三个 Tab：

| Tab | 内容 |
|---|---|
| 员工档案 | 列表 + 编辑弹窗。字段：姓名、岗位、手机、邮箱、用工类型、时薪、入职日期、生日、紧急联系人、状态。有"邀请开通账号"按钮 |
| 排班 | 周视图，按员工分行。点击格子新增/编辑班次 |
| 考勤 | 列表 + 日期筛选。可补卡（**必须带原因填写**，会写审计） |

**生日字段**：显示时要提示这是敏感信息、员工可关闭记录。

### 6.2 `/{locale}/team/care`

| 区块 | 内容 |
|---|---|
| AI 待办 | 卡片列表：生日 / 连续上班 / 超时工时 / 长班次 / 入职周年 / 漏打卡。每张有"采纳"与"忽略" |
| 关怀记录 | 我创建的 + 关于我的。**注意：老板看不到别人创建的记录内容**，UI 上不要设计成"全部记录"列表，否则一定被投诉 |
| 资源 | 心理支持资源库，可复制链接发给员工 |

**采纳一个有副作用的待办（比如发生日券）会走审批链**，UI 要显示"等待审批"状态，
不要显示成"已完成"。

---

## 7. 接口契约（前端对接用）

所有接口都在同域，`credentials: 'include'` 带上 cookie。
错误响应统一为 `{ "error": "<人类可读信息>" }`，部分带 `code`。

### 7.1 顾客端

#### `GET /api/store/menu?token={token}` — 已存在

```jsonc
// 200
{
  "store": { "name": "…", "intro": "…", "hours": "…", "currency": "USD" },
  "table": "A1",              // 堂食时有值；外卖入口为 "WEB"
  "categories": ["主食", "饮品"],
  "products": [{
    "id": "…", "name": "…", "category": "…", "price": "12.00",
    "description": "…", "image_url": "…", "video_url": null, "sales_count": 42
  }]
}
// 404 { "error": "Invalid or inactive store link" }
// 409 { "error": "Store profile is not configured yet", "code": "store_profile_missing" }
```

#### `POST /api/store/orders` — 已存在

```jsonc
// 请求
{ "token": "…", "items": [{ "product_id": "…", "qty": 2 }],
  "notes": "", "tip": 0, "idempotency_key": "…" }
// 201 { "order_no": "…", "total": 24.0, "id": "…" }
```
`idempotency_key` 由前端生成一次、重试复用同一值（现有实现已如此）。

#### `POST /api/store/delivery-orders` — **待实现**

```jsonc
// 请求
{ "token": "…", "items": [{ "product_id": "…", "qty": 2 }],
  "recipient_name": "…", "recipient_phone": "…",
  "address_line": "…", "address_note": "",
  "customer_address_id": null,        // 可选，已登录时
  "notes": "", "idempotency_key": "…" }
// 201
{ "order_id": "…", "order_no": "…",
  "subtotal": 24.0, "fee": 3.0, "total": 27.0,
  "promised_at": "2026-09-10T12:35:00.000Z" }
// 400 字段校验失败 / 未达起送价
// 404 token 无效
// 409 商家未开启外卖
```

#### `GET /api/site/config?slug={slug}` — **待实现**

外卖与预约的商家级配置，模式切换用它决定显示哪些 tab。

```jsonc
// 200
{ "store": { "name": "…", "currency": "USD", "hours": "…" },
  "modes": { "dine_in": true, "delivery": true, "booking": true, "menu": true },
  "delivery": { "minOrderAmount": 20, "fee": 3, "freeDeliveryAbove": 50, "prepMinutes": 35 },
  "theme": { "primary": "#0f766e", "accent": "#f59e0b", "surface": "#ffffff", "font": "sans" } }
```

#### `POST /api/site/reservations` — 已存在

```jsonc
// 请求
{ "slug": "…", "customer_name": "…", "phone": "…",
  "party_size": 2, "reserved_at": "2026-09-11T11:00:00.000Z", "notes": "" }
// 200 { "ok": true, "id": "…" }
// 400 字段校验 / 时间不在可预约窗口（须在 1 小时~180 天之间）
// 404 站点不存在或未发布
// 429 限流（按 IP 与 slug 两条线）
```

#### `POST /api/customer/auth/register` · `login` · `logout` — **待实现**

```jsonc
// register 请求
{ "slug": "…", "email": "…", "phone": "", "password": "…", "display_name": "…", "locale": "en" }
// login 请求
{ "slug": "…", "identifier": "邮箱或手机号", "password": "…" }
// 200（register / login）
{ "ok": true, "account": { "id": "…", "email": "…", "display_name": "…" } }
// 401 { "error": "invalid credentials" }
// 409 { "error": "an account with that email already exists" }
```

#### `GET /api/customer/orders` · `GET /api/customer/orders/{id}` — **待实现**

```jsonc
// 列表 200
{ "orders": [{ "id": "…", "order_no": "…", "channel": "delivery",
               "status": "pending", "total": 27.0, "created_at": "…",
               "rider_status": "claimed" }] }
// 详情 200 同上 + items / 配送地址 / 时间线
// 404 不属于当前顾客的订单一律 404（不是 403 —— 403 会泄漏"这个订单存在"）
```

#### `GET/POST/PATCH/DELETE /api/customer/addresses` — **待实现**

```jsonc
{ "id": "…", "label": "家", "recipient_name": "…", "recipient_phone": "…",
  "address_line": "…", "address_note": "", "is_default": true }
```

### 7.2 员工端

#### `POST /api/auth/login` — 已存在，员工端复用

```jsonc
{ "email": "…", "password": "…" }
// 200 { "access_token": "…", "user_id": "…", "tenant_id": "…", "business_id": "…", "role": "staff" }
// 401 / 429（限流）
```

#### `GET /api/staff/me` — **待实现**

```jsonc
// 200
{ "staff": { "id": "…", "name": "…", "position": "…", "photo_url": null },
  "business": { "id": "…", "name": "…" },
  "role": "staff",
  "preferences": { "personal_data_opt_in": false } }
// 409 { "error": "your account is not linked to a staff profile", "code": "staff_not_linked" }
```

#### `POST /api/staff/attendance` — **待实现**

```jsonc
// 请求：无参数。方向由服务端判定
// 200 { "action": "clock_in", "at": "…", "attendance_id": "…" }
// 200 { "action": "clock_out", "at": "…", "attendance_id": "…", "worked_minutes": 432 }
// 409 { "error": "already clocked in", "code": "already_open" }
```

#### `GET /api/staff/attendance?from=&to=` — **待实现**

```jsonc
{ "records": [{ "id": "…", "clock_in_at": "…", "clock_out_at": "…", "worked_minutes": 432 }] }
```

#### `GET /api/staff/shifts?from=&to=` — **待实现**

```jsonc
{ "shifts": [{ "id": "…", "starts_at": "…", "ends_at": "…", "role": "前厅", "note": "" }] }
```

#### `GET /api/staff/deliveries` — **待实现**

```jsonc
{ "pending": [{ "id": "…", "order_no": "…", "address_line": "…", "recipient_phone": "…",
                "total": 27.0, "created_at": "…", "promised_at": "…",
                "items_summary": "宫保鸡丁 x1 等 3 件" }],
  "mine":    [{ "…同上…", "rider_status": "claimed" }] }
```

#### `POST /api/staff/deliveries/claim` — **待实现**

```jsonc
{ "delivery_id": "…" }
// 200 { "ok": true, "delivery_id": "…", "rider_status": "claimed" }
// 409 { "error": "already claimed by someone else", "code": "already_claimed" }
```

#### `POST /api/staff/deliveries/{id}/status` — **待实现**

```jsonc
{ "status": "picked_up" }   // 或 "delivered"
// 200 { "ok": true, "rider_status": "picked_up" }
// 403 不是自己的单
// 409 状态不允许这样跳（例如 delivered → picked_up）
```

#### `GET /api/staff/reservations?date=YYYY-MM-DD` — **待实现**

```jsonc
{ "reservations": [{ "id": "…", "customer_name": "…", "phone": "…",
                     "party_size": 4, "reserved_at": "…", "table_no": null,
                     "status": "pending", "notes": "" }] }
```

#### `POST /api/staff/reservations/{id}/confirm` — **待实现**

```jsonc
{ "status": "confirmed" }   // confirmed | arrived | cancelled
// 200 { "ok": true }
// 403 跨门店
// 409 状态冲突
```

#### `GET /api/staff/care-resources` — **待实现**

```jsonc
{ "resources": [{ "title": "…", "description": "…", "url": "…", "phone": "…", "region": "global" }] }
```

### 7.3 老板端

#### `GET/POST/PATCH /api/team` — **待实现**

```jsonc
// GET 200
{ "staff": [{ "id": "…", "name": "…", "position": "…", "phone": "…", "email": "…",
              "employment_type": "full_time", "hourly_rate": "18.00",
              "hired_at": "2025-03-01", "birthday": "1998-04-12",
              "status": "active", "is_active": true,
              "user_id": "…", "has_account": true }] }
// POST/PATCH 请求：同上字段子集
// 权限：workforce:manage；老板端经理也可用
```

#### `GET/POST/DELETE /api/team/shifts` — **待实现**

```jsonc
{ "staff_id": "…", "starts_at": "…", "ends_at": "…", "role": "…", "note": "…" }
```

#### `GET /api/team/attendance?from=&to=&staff_id=` — **待实现**

```jsonc
{ "records": [{ "staff_id": "…", "staff_name": "…",
                "clock_in_at": "…", "clock_out_at": "…",
                "worked_minutes": 432, "clock_in_source": "staff_pwa" }] }
```

#### `PATCH /api/team/attendance/{id}` — **待实现（补卡）**

```jsonc
{ "clock_in_at": "…", "clock_out_at": "…", "reason": "必须填写" }
// 400 reason 缺失
// 403 无 workforce:manage
```

#### `POST /api/team/invite` — **待实现（依赖既有邀请链路修复）**

```jsonc
{ "staff_id": "…", "email": "…" }
// 200 { "ok": true, "invite_url": "https://…" }   // 必须非 null
```

#### `GET /api/team/care/signals` — **待实现**

```jsonc
{ "signals": [{ "id": "…", "staff_id": "…", "staff_name": "…",
                "kind": "birthday", "title": "…", "detail": "…",
                "due_at": "…", "status": "open" }] }
```

#### `POST /api/team/care/tasks/{id}` — **待实现**

```jsonc
{ "decision": "accept" }   // accept | dismiss
// accept 有副作用时：200 { "ok": true, "approval_id": "…", "status": "awaiting_approval" }
// UI 必须显示"等待审批"，不能显示成"已完成"
```

#### `GET/POST /api/team/care/notes` — **待实现**

```jsonc
// GET 只返回 (author = 我) 或 (subject = 我) 的记录
{ "notes": [{ "id": "…", "staff_id": "…", "kind": "one_on_one",
              "content": "…", "created_at": "…" }] }
// 以 owner 身份请求他人记录 → 403（这是刻意设计，不是 bug）
```

#### `GET /api/staff/export` — **待实现**

返回 `Content-Disposition: attachment` 的 JSON。

---

## 8. 设计约束（项目既有规则，不是我的偏好）

| 约束 | 出处 / 说明 |
|---|---|
| **组件库一律用 shadcn/ui** | `src/components/ui/` 下 54 个组件已就绪。不要引入别的 UI 库 |
| **样式只用 `@theme` 里的 token** | `bg-surface`、`text-on-surface-variant`、`shadow-card`、`rounded-lg` 等 60+ 个。**不要写死颜色值**（商家主题色除外，那个必须动态） |
| **禁止 `<head>` 标签** | 用 Next 的 `metadata` / `generateMetadata`。manifest 链接也走 metadata |
| **禁止在渲染期用 `Date.now()` / `Math.random()` / `typeof window`** | 会触发 hydration 错误。必须 `'use client'` + `useEffect` + `useState` 延后到挂载后 |
| **禁止 `<p>` 里嵌 `<div>`** | 非法 HTML 嵌套会导致 hydration 失败 |
| **翻译键不能含点号** | next-intl 客户端校验会抛 `INVALID_KEY` 直接崩渲染。动态键必须写成嵌套对象 |
| **三语文案必须同步** | `en` / `zh` / `es`。`tests/i18n-parity.test.ts` 会断言键集合完全一致，缺一个就红 |
| **移动优先** | 三个 PWA 都是 `standalone` + `portrait`。员工端和顾客端按 375px 宽设计 |
| **安全区** | iOS PWA 有底部横条，底部导航要留 `env(safe-area-inset-bottom)` |
| **零新增依赖** | 不能用新的 npm 包。图表、日期、动画都用现有的 |

### 8.1 i18n 命名空间分配（避免撞车）

| 命名空间 | 归属 | 状态 |
|---|---|---|
| `store` | 顾客端点餐 | 已存在 |
| `site` | 公开官网 | 已存在（Phase 17） |
| `website` | 老板端官网页 | 已存在（Phase 17） |
| `nav` | 侧边栏 | 已存在，已有 `website` 键 |
| **`staff`** | 员工端全部文案 | **你要新建** |
| **`team`** | 老板端员工管理 | **你要新建** |
| **`care`** | 关怀相关 | **你要新建** |
| **`delivery`** | 外卖相关文案 | **你要新建** |

新建命名空间时三语一起加。改完自己跑一次 `npx tsx --test tests/i18n-parity.test.ts`。

---

## 9. 必须处理的边界情形（这些决定 UI 的完成度）

| 情形 | 要求 |
|---|---|
| 空态 | 每个列表都要有空态文案。不要显示空白页，也不要显示转圈到永远 |
| 加载态 | 用 `Skeleton` 或 `Spinner`，不要用页面级遮罩 |
| 网络失败 | 明确错误提示 + 重试按钮。不要静默吞掉 |
| 401 | 跳对应端的登录页（顾客→顾客登录，员工→员工登录） |
| 403 | 提示"没有权限"，不要跳登录（会让人以为自己没登录） |
| 409 | 按语义分别处理：接单被抢→移除卡片；未关联档案→引导联系店长；状态冲突→刷新数据 |
| 429 | 显示"操作太频繁，请稍后再试"，不要显示原始错误 |
| 离线 | 至少不要白屏。PWA 冷启动失败要有可读提示 |
| 并发 | 接单、打卡、确认预约都可能被别人同时操作。**一律以服务端响应为准** |
| 长文本 | 地址、备注要截断 + 展开，不要让卡片被撑破 |
| 金额 | 一律用 `fmtCurrency(amount, currency, locale)`（`src/lib/format.ts`），不要自己拼 `$` |

---

## 10. 明确不属于前端范围

| 不归你 | 归属 |
|---|---|
| 数据库迁移、DDL | 我 |
| API 路由与鉴权 | 我 |
| 权限矩阵 `src/lib/rbac.ts` | 我 |
| manifest 的**生成**（动态路由） | 我 |
| `app-shell.tsx` 的 `/staff` 旁路 | 我（共享组件） |
| 邀请链路修复 | 我 |
| 推送的**发送端** | 我 |
| 推送的**接收端 UI**（订阅开关） | 你，复用 `src/components/pwa/PushSubscribe.tsx` |

---

## 11. 你可以自测的验收项

不依赖后端实现，你现在就能保证的：

1. 三个 manifest URL 在浏览器里能打开且 JSON 合法（后端做出来后）。
2. 375px 宽下三个入口都不出现横向滚动条。
3. 底部导航在 iOS 安全区不被遮挡。
4. 断网状态下不白屏。
5. 所有列表都有空态。
6. `npx tsx --test tests/i18n-parity.test.ts` 通过（三语键集合一致）。
7. `pnpm ts-check` 退出 0。
8. `pnpm lint` 无 error。
9. Lighthouse PWA 项通过（可安装、有 manifest、有 SW、HTTPS）。
10. 顾客端不出现任何"后台"字样；员工端不出现任何金额/营业额/客户数据。
