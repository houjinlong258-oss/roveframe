# Phase 18 PWA 前端交付评审

评审对象：`roveframe-three-tier-pwa-premium.zip`（160,882 bytes，sha256 `92530513`）
评审方式：解压到仓库外 `_pwa-review/` 后逐项实测。**未向仓库写入任何文件。**
状态：架构结论已完成；三端 UI 完成度的深读在进行中（见 §7）。

---

## 1. 一句话结论

这是一份**质量不错的 UI 原型**，但它不是可以接进本项目的前端：它是一个独立的
Google AI Studio 生成的 Vite SPA，**后端是浏览器内的 Mock 引擎，一次 HTTP 调用都没有**。

它证明了界面设计可行。它没有证明任何一条数据能真的落库。

**立刻要做的两件事**（与是否采用这份代码无关）：

1. `GoogleDeliveryMap.tsx:28-29` 里有一个**硬编码的 fallback 凭据字面量**
   （64 位十六进制，非 `AIza` 形态）。它是否为真实可用的 Google Maps key 是 UNVERIFIED，
   但它就是环境变量缺失时实际生效的值。先确认，无法确认就删除或轮换（详见 §7.3）。
2. **不要把这个 zip 解压到仓库目录**：它有 10 个路径与仓库现有文件同名（见 §4.5），
   其中包含 `package.json`、`tsconfig.json`、`.gitignore` 和本项目的两份 Phase 18 文档。
   已在仓库外解压评审，仓库当前未被污染（已实测确认）。


---

## 2. 交付物性质（全部实测）

| 项 | 实测结果 | 证据 |
|---|---|---|
| 应用形态 | 独立 Vite SPA，**不是** Next.js 路由 | `vite.config.ts`、`index.html`、`src/main.tsx`、`src/App.tsx`；无 `next.config.ts`、无 `src/app/` |
| 来源 | Google AI Studio 生成的脚手架 | `package.json` 的 `name` 是 `react-example`；README 是 AI Studio 模板原文（"Run and deploy your AI Studio app"）；`metadata.json` 声明 `MAJOR_CAPABILITY_SERVER_SIDE_GEMINI_API` |
| 后端 | **浏览器内 Mock 引擎** | `src/lib/api.ts` 文件头自称 "In-Browser High-Fidelity Mock Engine"；`fetch(` 出现 **0** 次、`XMLHttpRequest` **0** 次；导出 `customerApi` / `staffApi` / `bossApi` 由模块内常量 + `localStorage`（6 处）驱动 |
| 规格来源 | 确实读过我给的规格 | zip 内 `docs/current/Phase18_Frontend_Specification.md`（104 行）与我那份 `Phase18_Frontend_Spec.md`（25,019 bytes）结构一致，是其精简版 |
| 包管理器 | npm + bun 双锁文件 | `package-lock.json`（100KB）、`bun.lock`（74KB）；项目规定只用 pnpm |
| 类型系统 | `typescript@^7.0.2` | 与项目 TS5 冲突 |

---

## 3. 值得保留的部分

这部分是真实工作量，不要丢：

| 项 | 实测 |
|---|---|
| 代码量 | 36 个文件；`CustomerPwa.tsx` 87KB、`OwnerPortal.tsx` 53KB、`StaffPwa.tsx` 46KB |
| 三语 | `src/lib/i18n.ts` 含 `zh` / `en` / `es` 三套完整文案（25KB），并自带 parity 测试，且正确地断言了"翻译键不得含点号" |
| 字段名与我实现的后端**基本一致** | `rider_status`(14 处)、`promised_at`(7)、`items_summary`(4)、`minOrderAmount`(3)、`freeDeliveryAbove`(2)、`prepMinutes`(3)、`staff_not_linked`(2)、`already_claimed`(3) |
| 内置 409 场景开关 | `simulationState.simulate409ClaimConflict`、`simulate409StaffNotLinked`、`latencyMs` —— 说明作者认真读了"409 必须按语义分别处理"那一段 |
| 三端切换 | `App.tsx:22-55` 按 `?pwa=` 与 pathname 切端，并动态替换 `<link rel="manifest">` |

---

## 4. 不能直接用的部分

### 4.1 零 HTTP —— 接不上任何真实后端

`src/lib/api.ts` 中 `fetch(` 与 `XMLHttpRequest` 各为 **0** 次。

zip 内规格第 15 行写着「前端已内置标准 Mock 适配层，后端落地后无需修改任何前端路径、字段名与参数」。
**这句话不成立**：mock 适配层不是"可切换的传输层"，它就是数据源本身。
接入真实后端至少要把三个 api 对象整体换掉，且要新增一层 HTTP 客户端、cookie 凭据、
错误码映射 —— 不是"无需修改"。

### 4.2 与我已实现的后端存在契约缺口

| 契约点 | 我的后端（已实现） | 这份前端 | 后果 |
|---|---|---|---|
| 未达起送价差额 | `shortfall` | **无** | 规格 §4.2 要求"按钮禁用 + 显示还差多少"，渲染不出来 |
| 起送价错误码 | `order_below_minimum` | **无** | 无法把"未达起送价"与其它 400 区分 |
| 状态冲突 | `invalid_transition` / `already_settled` | **无** | 骑手推进失败时只能退化成通用错误提示 |
| 员工档案停用 | `staff_inactive` | **无** | 停用员工只能看到"未关联档案"这一种提示，指向错误的解决方式 |
| 下单幂等 | `Idempotency-Key` header + 内容指纹 | **无** | 重复提交保护缺失，顾客连点两次会下两单 |
| 补卡原因字段 | `reason` | `audit_reason` | 字段名不一致，接口会对不上 |
| 关怀记录作者字段 | `author_user_id` | `author_id` | 同上 |

### 4.3 manifest 与它自己的规格表不符

zip 内规格 §2 的表格写的是动态 URL、按商家 `id`/`scope` 区分。实现是三个静态文件：

| 项 | 规格表要求 | 实际实现 |
|---|---|---|
| manifest URL | `/{locale}/site/{slug}/manifest.webmanifest` 等动态路由 | 静态 `public/manifest-*.webmanifest` |
| `id` | `/{locale}/site/{slug}/`、`/{locale}/staff/`、`/` | `/customer-pwa`、`/staff-pwa`、`/owner-pwa` —— 与规格表不同（但 `id` 互不相同，这一点是对的） |
| `scope` | 各端独立、顾客端按商家 | **三个全是 `"/"`**，与规格表冲突 |
| `start_url` | 带商家标识 | `/?pwa=customer&mode=dine_in` —— **不含任何商家标识** |
| `name` | 商家名称（动态） | 硬编码 `"Grove Bistro & Café - Customer"` |

因此「PWA 根据商家信息自动生成」这一条**没有实现**：manifest 是写死的文件，
换一个商家装出来的还是 Grove Bistro。

另外：`index.html` 引用 `/pwa-192x192.png` 作为 apple-touch-icon，
但 `public/` 目录里**只有 `icon.svg`**，该文件不存在 —— iOS 上图标是死的。

### 4.4 新增依赖与项目规定冲突

| 依赖 | 问题 |
|---|---|
| `@google/genai` | Gemini SDK。项目已有 10 家服务商的 AI 路由（`src/lib/ai/`），用户主力模型是 Claude。实测在 `App.tsx` 及三端组件中**引用 0 次** |
| `@googlemaps/js-api-loader` + `VITE_GOOGLE_MAPS_API_KEY` | Google Maps 是付费外部服务；蓝图 §5 明确写了本期「不做地图」 |
| `express`、`esbuild`、`motion`、`tsx`、`autoprefixer`、`typescript@^7` | 项目零新增依赖原则；TS7 与项目 TS5 冲突 |
| Google Fonts（`fonts.googleapis.com`） | 运行时外部网络依赖；且 Playfair Display / Plus Jakarta Sans 与项目 `@theme` 设计系统不是同一套 |

### 4.5 直接解压到仓库根会静默覆盖 10 个文件

| 路径 | zip 大小 | 仓库现有大小 | 后果 |
|---|---|---|---|
| `package.json` | 967 | 4,704 | **依赖表被整体替换** |
| `tsconfig.json` | 553 | 710 | TS 配置被替换 |
| `.gitignore` | 73 | 3,658 | 忽略规则丢失（含 `*.env` 保护） |
| `README.md` | 542 | 4,275 | 被 AI Studio 模板覆盖 |
| `.env.example` | 355 | 3,741 | 被 Gemini/Maps 模板覆盖 |
| `docs/current/Phase18_Construction_Blueprint.md` | 4,990 | 28,769 | **我的施工图被精简版覆盖** |
| `src/components/pwa/InstallPrompt.tsx` | 5,833 | 3,806 | 现有安装引导被替换 |
| `src/components/pwa/PushSubscribe.tsx` | 1,342 | 2,237 | 现有推送订阅被替换 |
| `src/lib/format.ts` | 2,052 | 2,227 | 现有格式化函数被替换 |
| `tests/i18n-parity.test.ts` | 1,699 | 4,870 | **现有 i18n 守卫被同名文件替换**（测的是另一套东西） |

这一条是操作层面最需要立刻注意的：**不要把这个 zip 解压到仓库目录里**。

---

## 5. 三条路，我推荐第 2 条

| 方案 | 做法 | 代价 |
|---|---|---|
| A 直接当独立应用部署 | 构建 Vite 产物，另配 CORS 与跨域 cookie | 两套前端并存（违反"禁止新增重复架构"）；跨域会话是新攻击面；丢掉 SSR 与官网 SEO；Google Maps 与 Gemini 两条新外部依赖 |
| **B 移植 UI，不搬应用**（推荐） | 把 TSX 组件作为**设计源**搬进 Next，落到规格里的三个路径；`api.ts` 的三个 mock 对象换成同源真实调用 | 需要一次真实移植；但复用现有会话 cookie、CSRF 边界、next-intl、shadcn/ui、`@theme` token |
| C 只当视觉参考 | 照着重画 | 浪费已有 350KB 的真实工作 |

推荐 B 的理由，全部基于实测：

1. 仓库已有 91 个 API 路由、会话 cookie、CSRF 与租户边界。同源接入直接复用，零新增攻击面。
2. 三端 PWA 里**顾客端需要 SEO**（顾客点进来之前先看到官网），而 SPA 给不了 SEO。官网现在是 Next SSR 的。
3. `scope: "/"` + `?pwa=` 的形态在多商家下不成立（§4.3），而 Next 的动态 manifest 路由能直接解决。
4. 把 mock 换成同源 HTTP 客户端，比新增 CORS + 跨域 cookie 便宜得多。

---

## 6. 如果走 B，需要改的清单

| 动作 | 具体 |
|---|---|
| 搬 UI | `src/components/{customer,staff,owner,delivery}/**` → Next 的 `src/components/`，去掉 `@/` 别名对 Vite 根的依赖（项目别名指向 `src/`） |
| 重写数据层 | `src/lib/api.ts` 的三个对象 → 一个同源 `fetch` 客户端；`credentials: 'include'`；`Idempotency-Key` header |
| 补契约缺口 | 见 §4.2 七条 |
| 落路由 | 顾客 `/{locale}/site/[slug]/order`、员工 `/{locale}/staff/*`、老板 `/{locale}/team*` |
| i18n | `src/lib/i18n.ts` 的三套文案 → 合并进 `messages/{en,zh,es}.json` 的 `store`/`staff`/`team`/`care`/`delivery` 命名空间 |
| 设计对齐 | 去掉 Google Fonts 与自有 `index.css`，改用项目 `@theme` token 与 `src/components/ui/` 的 shadcn 组件 |
| 删除 | `@google/genai`、Google Maps 两个组件与依赖、`express`、`esbuild`、`motion`、双锁文件 |
| 保留改造 | `InstallPrompt` / `PushSubscribe` 用语义合并，**不要**直接覆盖现有文件 |
| manifest | 改成 `src/app/[locale]/site/[slug]/manifest.webmanifest/route.ts` 与 `src/app/[locale]/staff/manifest.webmanifest/route.ts` |

---

## 7. 三端 UI 完成度（只读深读结果）

### 7.1 顾客端（已完成深读）

| 规格要求 | 实现 | 结论 |
|---|---|---|
| 四个模式切换 | `CustomerMode = 'dine_in'\|'delivery'\|'booking'\|'menu'`（`types/index.ts:8`），`CustomerPwa.tsx:74` 持有 state，`App.tsx:36-41` 从 `?mode=` 白名单读入 | **有** |
| 模式 tab 文案三语 | `i18n.ts:189-192`（zh 堂食点单/外卖配送/订座预约/浏览菜单）、`:355-358`（en Dine-in Order/Delivery/Reservation/Browse Menu） | **有** |
| 起送价：按钮禁用 + 显示差额 | `:260,266,267` 计算，`:1241,1257` 显示"差 X"，`:1588` 提交前 guard | **有**（但差额字段是我后端要提供的 `shortfall`，见 §4.2） |
| 配送费 / 满额免配送展示 | `:651-668`、`:1232-1234`、`:1555-1562` | **有** |
| 金额不由客户端决定 | 客户端只提交 `items/tip/tip_rate/notes/address`（`:282-289`、`:308-319`），**不传金额**；mock 侧自行重算（`api.ts:572-591`、`:628-652`） | **符合规格** |
| 顾客登录 | 弹层 `:1617-1697`，但**没有注册路径**（`handleAuthSubmit` 只调 `customerLogin`，`:379`；"立即注册"只切换 `authMode`，`:1677`） | **部分** |
| 密码校验 | `customerLogin(identifier, pass)` **忽略 pass**（`api.ts:772-782`）—— 任意非空密码都能登录 | **未实现** |
| 地址簿 | `:121`、`:1345-1366`、`:1414-1425`（登录后才保存） | **有** |
| 历史订单 | `:120`、弹层 `:1700-1772` | **有** |

顾客端发现的三处需要修正：

1. **菜单模式下仍可下单。** `:966`、`:1061` 隐藏了数量控件、`:1194` 隐藏了购物车，但 `DishDetailModal` 调用时没传 `canOrder`（`:1792-1799`），其默认值是 `true`（`DishDetailModal.tsx:37`）。
2. **模式 tab 首屏只出两个。** `:468-473` 的 delivery/booking tab 依赖 `config.modes`，而 `config` 初值是 `null`（`:78`）；同时首页那个四宫格（`:573-577`）是硬编码的，不受 `config.modes` 控制 —— 两处口径不一致。
3. **en/es 切换对这个页面基本无效。** 大量文案是硬编码中文（`:457`、`:507`、`:793`、`:828`、`:1010`、`:1291`），只有模式 tab 与少数 `site.*` 键走了 `t()`。

### 7.2 两个非规格组件

| 组件 | 实测行为 | 判断 |
|---|---|---|
| `KitchenInspectionModal` "阳光透明后厨" | 后厨照片墙 + 分类筛选 + 灯箱。合规信息是**硬编码字面量**：`1.8-2.3C`（`:106`）、"4 次全区巡查"（`:115`）、"Grade A"（`:124`） | **有风险**，见下 |
| `KitchenPhotoUploadModal` | "上传"实际是从 4 张预设 Unsplash 模板里选一张（`:23-49`、`:90-102`） | 原型行为 |
| `FlyingDishOverlay` | 纯动效：Dynamic Island 提示 + 36px 菜品飞入购物车，无 API 调用、无自身状态 | 保留，无害 |

**"Grade A / 1.8-2.3°C / 4 次全区巡查" 是必须处理的。**

这组数字是写死的，但呈现方式是"本店后厨合规等级 A"。它和这个仓库上一轮修掉的那个问题是同一类：

> `src/lib/connectors/capabilities.ts:18` —— 「这不是崩溃，是**误导**：老板会据此做采购决策。比报错更危险。」

只不过这次被误导的是**顾客**，而且内容涉及食品安全。顾客基于"A 级"做消费决策，商家拿它当卖点 —— 而这些数字没有任何数据来源。`CustomerPwa` 还传了 `canUpload={true}`（`:1809`），等于把"上传后厨照片"开放给顾客。

处理方式只有两种：接上真实数据，或者删掉。**不能保留硬编码版本**。

### 7.3 地图与密钥

| 项 | 实测 |
|---|---|
| 密钥来源 | `import.meta.env.VITE_GOOGLE_MAPS_API_KEY`，**带硬编码 fallback 字面量**（`GoogleDeliveryMap.tsx:28-29`） |
| 该字面量 | 注释写 "User-provided custom Google Maps API key"，值是 64 位十六进制串 `be043249…6369` |
| 包内是否有 `.env` | **没有**，只有 `.env.example:7` |
| 因此实际生效的凭据 | **就是那个提交在代码里的字面量**（当环境变量缺失时） |
| 无地图时的降级路径 | **不存在**。`DeliveryTrackerMap.tsx:201-206` 无条件渲染地图；加载失败只有一个错误遮罩 + 外链（`:418-441`） |
| "GPS Live" | 假的：`DeliveryTrackerMap.tsx:103-116` 用 2 秒 `setInterval` 模拟坐标，骑手数据是预设的（`:72-100`） |

<details>
<summary>修正：先前写成"视为已泄漏"，说过头了</summary>

先前措辞（评审第一版 §7.3 与 §1）：

> `GoogleDeliveryMap.tsx:27-29` 里有一个**硬编码的 Google Maps API key** 作为 fallback，
> 而包里没有 `.env` —— 该字面量就是实际生效的凭据。视为已泄漏，去 Google Cloud Console 轮换。

亲自复核后需要收窄：该值 `be0432492e42867a0ff6b0358268372b1197ec32c064cc7864adcc69022d6369`
是 **64 位十六进制**，而 Google Maps API key 的正常形态是 `AIza` 开头的 39 字符串。
**它是否是一个真实可用的 Google Maps 凭据，UNVERIFIED。**

</details>

准确的结论是：代码里提交了一个**充当 API 凭据的字面量**。它不符合 Google Maps key 的形态，
因此更可能是一串占位或哈希；但只要它曾经有效、或日后被人替换成有效值再提交，就是同一类问题。
先确认它是什么；无法确认就删除或轮换。

而无论它是什么，**环境变量缺失时静默回落到一个提交在仓库里的凭据**这个写法本身就不该保留。
真要用地图，正确做法是缺少 key 时明确报错，而不是回落到一个写死的值。

### 7.4 员工端与老板端（已完成深读）

**做对的部分：**

| 规格要求 | 实现 | 结论 |
|---|---|---|
| 打卡不传方向 | `staffApi.recordAttendance()` 零参数（`StaffPwa.tsx:170`），`api.ts:882-899` 注释明写 "Direction determined by server"；UI 按返回的 `res.action` 分支（`:174-180`） | **符合规格** |
| 补卡只能店长做 | 员工端把补卡引导到店长（`:580-582`），老板端有补卡弹层（`:478-485`、`:950-1040`） | **符合规格** |
| 补卡必填原因 | guard `:126-129`、textarea required `:1019-1027`、行内错误 `:970-974` | **符合规格** |
| 派单两组 + 接单按钮 | pending `:666-730`、mine `:732-807`、认领按钮 `:720-726` | **有** |
| 409 处理 | `:197-209` 判断 `e.code === 'already_claimed'`，把卡片移出 pending（`:201-204`） | **有，但反馈是错的**（见下） |
| 关怀资源只做转介 | `:950-981`，明确不做问卷/评分（`:956-958`） | **符合规格** |
| 员工数据导出 | `:934-948` → `api.ts:1087-1109` 真实 blob 下载 | **有** |
| 隐私开关默认关闭 | `:915-932` → `setStaffPreference`（`:238-248`） | **有** |

**缺失的部分：**

| 规格要求 | 实测 |
|---|---|
| 老板端排班 UI | **缺失**。`shifts` tab 标着 `t.team.tab_scheduling`（`:230`）但渲染的是考勤表，标题还是 `t.team.tab_attendance`（`:473`）；店长侧没有排班 API，`api.ts` 只有员工的 `getShifts`（`:938`）；`team.shift_add/role/notes` 三个 i18n 键未被使用（`:312-314`） |
| 员工表单里的生日字段 | **缺失**。`types:315` 定义了 `birthday`，但编辑弹层 `:1103-1221` 没有这个输入框 |
| 生日提醒的可视化 | **只有数据**。种子里有 `kind: 'birthday'` 的信号（`api.ts:402-412`），但没有列表、没有日历 |
| 连续上班提醒 | **只有数据**（`api.ts:413-423`） |
| 超时工时 / 长班次提醒 | **缺失**。类型联合里有（`types:338`），没有种子、没有 UI |
| AI 待办列表 | **缺失**。只有一个通用信号卡渲染器（`:563-616`），无按 kind 分支；整个 `care.*` i18n 命名空间未被使用（`i18n.ts:148-164`），tab 标题硬编码中文 |
| 老板端登录 | **缺失**。见 §7.5 |

### 7.5 接入真实后端会立刻出问题的五处

这四处不是"风格问题"，是**接上我的后端就会坏**的地方。

**① 抢单失败看起来像抢单成功**

`:201-205` 在 `already_claimed` 时把卡片移出列表**并**用 `t.staff.claimed_by_other` 提示 —— 但它复用了**成功用的那个青色横幅和 `CheckCircle2` 成功图标**（`:365-383`）。视觉上"被同事抢走"和"接单成功"完全一样。

一个员工点了接单，看到绿色对勾横幅，会以为单子在自己手上。规格 §9 要求的正是相反的处置（"不要把已被抢走显示成普通错误"）—— 这里是走到另一个极端：显示成了成功。

另外它**不重新拉取**，也不动 `mine` 分组，所以真实归属只能等下一次刷新才对上。

**② 关怀记录：一个 403 会把整个老板端变空白**

`OwnerPortal` 调 `bossApi.getCareNotes()` 不传参数（`:94`）；mock 里默认 `currentUserId='usr_owner'`（`api.ts:1234`）并按 `author_id === 我 || staff_id === 我` 过滤（`:1249`）。组件把**返回的每一条都渲染**（`:633-648`），没有任何逐条检查 —— 所以它是一个"跨员工列表"，不是按员工查看，尽管它自己的表头写着「仅对沟通双方授权可见」（`:623`）。

我的后端对他人关怀记录返回 **403**（`docs/current/Phase18_Construction_Blueprint.md` §4.3 的 P18-7）。而 `getCareNotes` 在一个 `Promise.all` 里，**它的 catch 是空的 `// ignore`**（`:106-108`）——

结果：**一次 403 会让整个老板端（团队、考勤、信号、配置）全部变空，且没有任何错误提示。**

创建关怀记录走同一条路，同一个空 catch（`:171-180`）：失败时弹层不关、不报错。

这是本次评审里**影响最大的一处**：它正好落在我特意加的隐私边界上。修法有两个方向，必须选一个：
- UI 侧：把关怀记录改成**按员工**查看（先选人，再取那个人的记录），并给该请求独立的错误处理；
- 或者保留全局列表，但后端改为返回"我可见的"而非 403 —— **不推荐**，那等于放开隐私边界。

**③ 老板端没有任何登录门**

`OwnerPortal` 只接 `locale` 一个 prop（`:42-48`），没有鉴权；`App.tsx:191-206` 靠 URL 参数与顶栏按钮切视图。也就是说三端是**同一个页面上切 tab**，切到老板端不需要任何凭据。

员工端同理：`isAuthenticated` 初值是 `true`（`:61`），密码框默认值就是字面量 `'••••••••'`（`:63`），`handleLogin` 里写着 `// Simulate login` 然后直接 `setIsAuthenticated(true)`（`:145-152`），不校验任何东西。

**④ 五处写操作静默失败**

全部是空 catch 加 `// ignore`：

| 位置 | 后果 |
|---|---|
| `:106-108` 老板端整体加载 | 一处失败 → 整页空白 |
| `:171-180` 创建关怀记录 | 弹层不关、无错误 |
| `:192-194` 保存门店配置 | 看起来保存成功 |
| `:161-163` 信号采纳/忽略 | 看起来已处理 |
| `:232-234` 员工端预约操作 | 看起来已完成 |

项目纪律里写明"禁止静默 fallback（宁可 fail-closed）"。这五处都是反过来的。

**⑤ 后厨照片：上传者给自己发合格证**

`KitchenPhotoUploadModal` 里**没有任何文件输入**（全仓 grep `type="file"` 与 `capture` 均为 0 命中）。所谓"上传"是从 4 张预设 Unsplash 模板里选一张（`:20-53`、`:90-102`），然后：

- 伪造 `id: kpic_<Date.now()>`、`uploaded_at: '今日 HH:MM'`（展示字符串，不是 ISO）、**`verified: true`**（`:86-99`）
- 让上传者**自己**给自己标记已核验
- 还有一次重复写入：组件推进本地 state（`StaffPwa:1030`），同时 `api.ts:1116-1128` 又存了一份 id 不同的副本

再加上 §7.2 那个硬编码的 "Grade A"，构成同一个问题：**后厨合规等级完全由前端自己宣布**。

### 7.6 其他实测到的硬编码与死控件

| 项 | 实测 |
|---|---|
| 老板端仪表盘 | `10月28日`、`张总`、`¥12,560`、KPI `248/36/42%/4.8`（`:274-302`） |
| 分析页 | `¥386,560`、12 根柱子、Top5 菜品、`10/1-10/31`（`:827-852`） |
| 死控件 | 分析页四个范围 tab（营业额/订单/顾客/菜品，`:837`）没有 onClick、没有 state |
| 死代码 | `onSwitchToOwner` 被声明并传递（`StaffPwa:50,56`、`App.tsx:202`）但从未调用；登出（`:984-990`）只改本地 state |
| 硬编码人物 | 员工端默认 `'Elena Rostova'`（`:335`）、入职日 `2024-03-15`（`:909`）；顾客端 `'Jane Doe'`、`'+1 (555) 345-6789'`、`'742 Evergreen Terrace'` |
| 桌号约定冲突 | 顾客端桌号 chips `['A1','A2','B3','V8']`（`api.ts:795`），`V8` 与项目约定 A1-A4 / B1-B8 冲突（AGENTS.md） |
| 员工端可见金额 | 待接单卡片显示订单总额（`:684-687`）、GPS 弹层显示 `支付总计` 与单价（`DeliveryTrackerMap.tsx:367-370`）。**汇总营业额/客户 360/财务看板均不存在** —— 符合规格 §6.3 的边界；单笔金额是配送收款所需，属于必要的例外，但应作为明确决定记录下来 |



---

## 8. 本次评审没有做的事

- 没有运行这份前端（未 `npm install`、未起 `vite dev`）。
- 没有把它接入仓库任何位置。
- 没有评价视觉设计的好坏 —— 那需要真机渲染，本机未做。
