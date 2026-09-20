# Phase 18 升级方案 —— 三端 PWA、外卖系统、员工端与员工关怀

状态：方案，待实施。
前置：Phase 17（内置数据库部署 + Agent 生成官网）正在收尾，见本文件 §0。

---

## 0. 前置：一处术语纠正

**此前把点餐端称为「H5 点单小程序」，这是错的。** 实测该前端是 PWA：

```
<details>
<summary>原文档措辞（保留，便于对照）</summary>

SelfHosted_Deploy_And_Merchant_Site_Plan.md §3.2：

> 「下单直接进 H5」—— 虚拟桌号……点餐 H5 已完整（购物车/小费/落单/幂等键）

</details>
```

纠正依据：

| 事实 | 证据 |
|---|---|
| 有 manifest | `src/app/manifest.ts`（Next 16 自动产出 `/manifest.webmanifest`） |
| 有 service worker | `src/app/sw.ts`、`public/sw.js` |
| 有安装图标 | `public/icons/icon-192.png`、`icon-512.png`、`icon-maskable-512.png` |
| 有安装提示组件 | `src/components/layout/app-shell.tsx` 渲染 `InstallPrompt` |

它一直是可安装的 PWA。后文与新增文档统一使用「顾客端 PWA」。

---

## 1. 现状核实（本次实测）

| 事实 | 证据 |
|---|---|
| manifest 只有一份、且是通用版 | `src/app/manifest.ts`：`start_url:'/'`、`scope:'/'` |
| 按商家动态 manifest 是**已规划未实现** | 同文件注释：「V1 通用 manifest……V2 子域路由上线后改为 `/api/manifest/[slug]` 动态 endpoint」 |
| 点餐页只有商品分类切换，无 点单/外卖/预定/菜单 模式切换 | `src/app/[locale]/store/page.tsx:37,65,246`（`activeCat` / `'__all__'`） |
| 顾客无账号，只有设备 cookie | `src/lib/customer-identity.ts:6`「V1 设计: 用 cookie 持 device_id(UUID v4)，无账号体系」 |
| 订单通道字段已存在 | `orders.channel varchar(20) not null default 'dine_in'` |
| 订单**没有**配送相关列 | `orders` 只有 items/total/channel/status/source/table_no/external_id |
| 员工表只有 8 列 | `staff`：id/tenant_id/business_id/name/role/photo_url/is_active/created_at |
| 无考勤/班次/生日/关怀表 | schema.ts 全量 51 张表清单 |
| 登录只有一套 | `src/app/[locale]/auth/login/page.tsx`、`signup/page.tsx` |
| 员工与账号无关联 | `users.role` 可取 `'staff'`，但 `users` 与 `staff` 之间无任何列相连 |
| 推送骨架已在 | `notifications`、`notificationOutbox`、`pushSubscriptions` |
| 预约公开接口此前不存在（Phase 17 已补） | `src/app/api/site/reservations/route.ts` |

---

## 2. 目标拆解

| 编号 | 需求原文要点 | 本方案章节 |
|---|---|---|
| A | 顾客端 PWA 按商家信息自动生成 | §3 |
| B | 顾客端点单 / 外卖 / 预定 / 菜单 四个入口 | §3、§4 |
| C | 顾客登录、订单可保存 | §5 |
| D | 员工端 PWA 与老板端分开登录 | §6 |
| E | 员工端能用 SaaS 的部分功能 | §6 |
| F | 老板的员工管理系统 | §7 |
| G | 员工关怀：生日提醒、打卡、考勤、超时工作提醒、心理支持 | §8 |
| H | 外卖/预定在员工端提醒，员工接外卖派单 | §9 |

---

## 3. 三端 PWA 拆分（A）

**结论：一个代码库，三个入口，靠 manifest + scope 区分，不做三个应用。**

同一 origin 可以安装多个 PWA，前提是 `scope` 互不重叠。

| 入口 | 路径 | scope | 图标 | 面向 |
|---|---|---|---|---|
| 顾客端 | `/{locale}/store/*` | `/store/` | 商家 logo + 主题色 | 顾客 |
| 员工端 | `/{locale}/staff/*` | `/staff/` | 平台固定图标 | 员工 |
| 老板端 | `/{locale}/dashboard` 等 | `/` | 平台固定图标 | 老板/经理 |

实现方式：`src/app/manifest.ts` 改为 `src/app/manifest/[role]/route.ts`（动态 manifest）。
`start_url`、`name`、`theme_color`、`icons` 由 `role` + 商家数据决定。
这正是现有代码注释里写好的 V2，不需要发明新架构。

图标：不新增图像处理依赖。商家上传的 logo 若 ≥512×512 就直接用作 `icons`；
否则**显式**回落到平台图标（不静默）。缺失 512 图标时 manifest 仍合法。

---

## 4. 外卖系统（B）

### 4.1 数据

不改 `orders` 的语义，只加通道和一张侧表：

```
delivery_orders(
  id, tenant_id, business_id,
  order_id uuid unique references orders(id),
  customer_account_id uuid null,      -- §5 顾客账号，游客下单为 null
  recipient_name, recipient_phone,
  address_line, address_note,
  lat numeric null, lng numeric null,
  fee numeric default 0,              -- 配送费
  min_order_amount numeric default 0, -- 下单门槛快照
  promised_at timestamptz,            -- 承诺送达时间
  rider_staff_id uuid null references staff(id),
  rider_status varchar(20) default 'pending',  -- pending|claimed|picked_up|delivered|cancelled
  claimed_at, delivered_at
)
```

`orders.channel='delivery'` 是既有合法值，无需 DDL。

### 4.2 顾客端四个入口

`/{locale}/store` 顶部改为四个模式：**点单（堂食）/ 外卖 / 预定 / 菜单**。

| 模式 | 数据来源 | 落单 |
|---|---|---|
| 点单 | 现有菜单 + 桌号 | 现有 `/api/store/orders`（`channel='dine_in'`） |
| 外卖 | 现有菜单 + 配送规则 | 新 `/api/store/delivery-orders`（`channel='delivery'` + `delivery_orders` 侧表） |
| 预定 | `public_sites` / 商家配置 | 复用 Phase 17 的 `/api/site/reservations` |
| 菜单 | 现有菜单，只读 | 无 |

配送规则（起送价、配送费、配送范围、营业时段）存 `settings.delivery` jsonb，
不新建配置表——它和现有 `settings.business/locale/ai_prefs` 是同一类东西。

服务端计价仍然照旧：**价格一律由服务端按 `products` 计算**，客户端传什么都不信。

---

## 5. 顾客账号（C）—— 本方案风险最高的一节

现状：顾客身份只是一个设备 cookie（`src/lib/customer-identity.ts:6`），
换设备/清 cookie 即丢失。要做"保存订单"必须有账号。

三个可选路径：

| 方案 | 做法 | 评价 |
|---|---|---|
| A | 复用 GoTrue，给顾客也建 auth user | **不推荐**。顾客与商家会进同一个用户池，`auth.admin` 的会话语义、`app_metadata.tenant_id` 约定都会被搅乱；这个项目已经因为共享 client 被用户 session 污染踩过一次坑（AGENTS.md 陷阱 8） |
| B | 自建 `customer_accounts` + Node 内置 `crypto.scrypt` 哈希 + 独立签名 cookie | **推荐**。零新增依赖，与商家认证完全隔离，出错也只影响顾客侧 |
| C | 只做手机号 OTP，无密码 | 需要短信通道（成本 + 合规），本期不做 |

推荐 B，并明确：

- 独立的 cookie 名（不复用 `roveframe_device_id`，也不复用商家会话 cookie）
- 独立的 session 表 `customer_sessions`
- 顾客永远拿不到 `service_role`，所有查询仍由服务端按 `customer_account_id` 过滤
- 游客下单必须继续可用（不能因为加了账号就逼迫登录），下单后提供"绑定到账号"入口

新增表：`customer_accounts`、`customer_sessions`、`customer_addresses`。

---

## 6. 员工账号与员工端 PWA（D、E）

### 6.1 先补一个真实缺口

`users` 与 `staff` 现在**没有任何字段相连**。这意味着"这个登录的人对应哪条员工记录"
无从查起——排班、考勤、派单全部没有归属。

第一步：`staff` 增加 `user_id varchar(36) references users(id)`，唯一索引。
这是后面所有员工功能的前置条件，不做它后面全是空中楼阁。

### 6.2 登录分离

| 项 | 老板端 | 员工端 |
|---|---|---|
| 登录页 | `/{locale}/auth/login` | `/{locale}/staff/login` |
| PWA scope | `/` | `/staff/` |
| 登录后落地 | `/dashboard` | `/staff/today` |
| 会话 | 复用现有 cookie | 同一套 cookie，但落地与导航按 `users.role` 分流 |

不做第二套认证——同一套凭据、同一套会话，区别只在入口、落地页和可见功能。
理由：两套认证意味着两套过期/登出/重置密码逻辑，是纯粹的重复。

### 6.3 员工端能用哪些 SaaS 功能

| 功能 | 员工端 | 依据 |
|---|---|---|
| 我的班次 / 打卡 | 可写 | 本人 |
| 待接外卖单、待确认预约 | 可写（认领/确认） | `orders:write` / `reservations:write` 的**受限**子集 |
| 桌台呼叫、任务清单 | 可写 | 现有 `staff` 相关接口 |
| 菜单查看 | 只读 | `products:read` |
| 营业额 / 客户 / 营销 / 财务 | **不可见** | 现有 RBAC 里 staff 本就没有这些权限 |

现有 `src/lib/rbac.ts` 已有 staff/manager/owner/admin 四档与权限矩阵，
员工端**不新增权限模型**，只是把已有矩阵真正用起来 + 加一个按角色渲染的导航。

---

## 7. 员工管理系统（F，老板端）

`staff` 表扩展（全部 `add column if not exists`，幂等）：

```
staff.user_id, phone, email, position, employment_type, hourly_rate,
hired_at date, birthday date, emergency_contact, status
```

新增页面 `/{locale}/team`（注意：**不能**叫 `/staff`，那是员工端 PWA 的 scope）：

- 员工列表 / 档案编辑 / 邀请开通账号（复用现有 invite 链路，但必须先修好 §10 里
  已知的邀请缺陷——目前 `invite_url` 返回 null，被邀请人永远无法登录）
- 排班表（`staff_shifts`）
- 考勤（`staff_attendance`）

---

## 8. 员工关怀系统（G）

### 8.1 数据

```
staff_shifts(      id, tenant_id, business_id, staff_id, starts_at, ends_at, role, note )
staff_attendance(  id, tenant_id, business_id, staff_id, shift_id null,
                   clock_in_at, clock_out_at, clock_in_source, note )
staff_care_notes(  id, tenant_id, business_id, staff_id, author_user_id,
                   kind, content, visibility )   -- visibility: private|staff|manager
staff_care_tasks(  id, tenant_id, business_id, staff_id, kind, title, due_at,
                   status, suggested_by, decided_by, decided_at )
```

### 8.2 AI 提醒怎么产生

不新增调度器。现有 `src/lib/scheduler.ts` 已有周期任务 + `cron_state` 心跳，
在这里加一个每日任务计算信号，写进现有 `notifications` / `alerts`：

| 信号 | 规则（阈值放 `settings.wellbeing`，可关） | 产出 |
|---|---|---|
| 生日临近 | 未来 7 天内 | 提醒老板：是否给予福利（可一键生成生日券） |
| 连续上班 | 连续 ≥6 天无休 | 提醒：安排休息 |
| 周工时超限 | 本周 > 48 小时 | 提醒：核查排班 |
| 长班次 | 单班 > 10 小时 | 提醒：可能违反当地劳动法 |
| 入职周年 | 满 1/3/5 年 | 提醒：是否需要奖励 |
| 考勤异常 | 漏打卡 / 迟到频次 | 提醒：与本人确认（**不做惩罚性自动扣款**） |

提醒本身**只是建议**。任何带副作用的结果（发生日券、调休）都走现有
`EnterpriseToolGate` 审批链，与其它高风险动作同一套。

### 8.3 边界（硬约束，不是免责声明）

| 数据 | 老板 | 经理 | 本人 | 其他员工 |
|---|---|---|---|---|
| 排班 / 考勤 | 可读 | 可读 | 只读自己 | 不可读 |
| 生日 | 可读 | 可读 | 可读自己 | 默认不可读 |
| 关怀记录内容 | **不可读**（只看到"已完成"） | 不可读 | 可读自己 | 不可读 |
| 位置 | 仅打卡瞬间，可选关闭 | 同左 | 可关闭 | — |

- 心理支持只做**资源转介**（EAP 热线、自助材料、休息建议）。
  **不做诊断、不存健康信息、不评分**。这条写进代码注释与接口契约。
- 不做后台定位、不做屏幕/操作监控、不做"效率分"。
- 考勤数据不得自动触发扣薪——系统只呈现事实，不代替人做处分决定。
- 目标市场在海外（AGENTS.md），考勤与生日属个人信息；GDPR 下需可导出、可删除、
  有保留期限。§11 列出必须随功能一起交付的能力。

---

## 9. 员工端提醒与派单（H）

| 事件 | 通道 | 落点 |
|---|---|---|
| 新外卖单 | 推送 + 员工端角标 | `/staff/deliveries`，员工点"接单" |
| 新预约 | 推送 + 列表 | `/staff/reservations`，员工确认/排桌 |
| 桌台呼叫 | 推送 | `/staff/tables` |
| 班次开始前 | 推送 | `/staff/today` |

**接单必须是原子操作**，否则两个员工会同时接到同一单：

```sql
update delivery_orders
   set rider_staff_id = $1, rider_status = 'claimed', claimed_at = now()
 where id = $2 and tenant_id = $3 and rider_status = 'pending'
returning id;
```

更新影响行数为 0 即表示"已被别人接走"——与仓库里
`claim_agent_task_runs` 修好的那类竞态是同一个模式（见 `scripts/migrate.sql`）。

推送复用 `pushSubscriptions` + 现有 `/api/notifications/push`，不引入新通道。

---

## 10. 实施顺序

| 阶段 | 内容 | 依赖 |
|---|---|---|
| **P17 收尾** | 官网切片跑通并实测（迁移落地 + 真实 HTTP 验证） | 无 |
| P18-1 | `staff.user_id` 关联 + 员工登录入口 + 角色分流落地页 | 无 |
| P18-2 | 动态 manifest（三端 PWA 可分别安装） | P18-1 |
| P18-3 | 员工端 PWA 骨架（今日/我的班次/打卡） | P18-1 |
| P18-4 | 外卖系统（侧表 + 顾客端四模式 + 配送规则） | 无 |
| P18-5 | 员工派单与提醒 | P18-3、P18-4 |
| P18-6 | 员工管理（`/team`、档案、排班、考勤） | P18-1 |
| P18-7 | 关怀信号 + AI 提醒 + 审批链 | P18-6 |
| P18-8 | 隐私能力（导出/删除/保留期）+ 三语文案 | P18-6、P18-7 |
| P18-9 | 顾客账号（§5） | 独立，风险最高，最后做 |

顺序理由：P18-9 风险最高且不影响其它模块，放最后；P18-1 是所有员工功能的前置，
必须先做；P18-4 与员工端互不依赖，可以并行。

---

## 11. 必须一起交付的隐私能力（否则不上线）

| 能力 | 说明 |
|---|---|
| 员工可导出自己的考勤与档案数据 | 一个接口 + 员工端入口 |
| 员工可申请删除 | 有审批与保留期，不即时物理删除 |
| 保留期限 | `settings.wellbeing.retentionMonths`，到期任务清理 |
| 关怀记录访问审计 | 谁读了谁的关怀记录进 `audit_events` |
| 开关默认值 | 关怀提醒默认**开启**，个性化数据收集默认**关闭**，由员工本人开启 |

---

## 12. 本机可验证 / 不可验证

**可在本机验证**：数据库迁移幂等、接口鉴权与越权拒绝、派单竞态的原子性、
三端 manifest 的 scope 不重叠、员工端不可见财务数据、限流。

**UNVERIFIED（需要真机/真环境）**：PWA 在三端的实际安装行为与图标选取、
推送在 iOS/Android 的到达率、多 manifest 在同一 origin 的浏览器兼容性。
