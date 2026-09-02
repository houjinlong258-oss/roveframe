# RoveFrame V1 · PWA 集成设计

> 起草：2026-09-03 01:10 (Mavis, release-manager)
> 目的：把 Next.js Web SaaS 升级为 PWA,让每家餐厅拥有自己的可安装 App
> 状态：PWA Sprint 1 + Sprint 2 起步(文档 + manifest + service worker + customer_favorites 表)

---

## 0. 一句话目标

每家餐厅在 `*.roveframe.com` 子域访问,**Add to Home Screen** 即可装上自己餐厅的 App。装上后像 Native App 一样启动,offline 也能看菜单,AI 主动推送经营异常给老板。

---

## 1. 现状盘点(已就位 vs 缺)

### ✅ 已就位

- Next.js 16 + App Router(PWA 基础)
- `app/[locale]/store/page.tsx` H5 商城 + QR 菜单(Customer PWA 入口)
- 25 个 API 路由(P0-S2 tenant 化)
- `tenants` / `businesses` / `users` 表 + tenant_id 隔离
- 10 家 AI 服务商(可触发主动推送)
- `lib/crypto` AES-256-GCM(Push 订阅 token 加密)
- `alerts` 表(可扩展为 PWA 推送源)
- i18n(en/zh/es)+ AppShell(Install Prompt 注入点)
- 路由表 `ƒ Proxy (Middleware)`(proxy.ts 可加 PWA 路由处理)

### ❌ 完全没接

| 缺失 | Sprint |
|---|---|
| `next-pwa` / `Serwist` 库 | 1 |
| `manifest.json` / 动态 `app/manifest.ts` | 1 |
| `service-worker.js` | 1 |
| `InstallPrompt` 组件 | 1 |
| `customer_favorites` 表 + API | 2 |
| `push_subscriptions` 表 | 4 |
| Icon 上传 / 自动生成(192/512) | 1-2 |
| 离线缓存策略 | 1-5 |
| AI Agent → 推送 触发 | 4 |

---

## 2. 8 个决策(我的提案,执行中可调)

### 决策 1:库选
- ✅ **Serwist**(Next.js 15+ 官方推荐,Workbox fork,活跃维护)
- ❌ next-pwa(已 archived)

### 决策 2:Customer / Owner PWA 拆分
- ✅ **两个独立 manifest**(`/store/manifest` + `/admin/manifest`),独立安装

### 决策 3:子域模型
- ✅ **沿用子域**(`tokyosushi.roveframe.com` 天然适配)

### 决策 4:Push 基础设施
- ✅ V1 **自建 Web Push + VAPID**
- 后续:FCM(移动 App)

### 决策 5:Customer Favorites 身份
- ✅ V1 **设备指纹 + cookie 兜底**
- 后续:customer 注册

### 决策 6:Push 触达源
- ✅ **复用 `alerts` 表**,加 3 个字段(`push_sent_at` / `push_endpoint` / `push_token`)
- 不新建 `notifications` 表

### 决策 7:Manifest 域绑定
- ✅ **每个 Business 独立 manifest + 子域**

### 决策 8:AI 主动推送触发
- ✅ **V1 用规则引擎**(revenue / review / churn 阈值),先做
- V2 接 AI Agent 后替换

---

## 3. 5-Sprint 实施计划(全 9 周)

### Sprint 1: PWA 基础(2 周)

**Commit 计划(7 commits)**:

| Commit | 文件 | 估时 |
|---|---|---|
| **C-PWA-1.1** | `package.json` + `pnpm install @serwist/next serwist` | 0.5h |
| **C-PWA-1.2** | `next.config.ts` 配 Serwist withInjectManifest 模式 | 0.5h |
| **C-PWA-1.3** | `src/app/manifest.ts` 动态 manifest(读 tenants + businesses 拼装) | 1h |
| **C-PWA-1.4** | `src/app/sw.ts` service worker 源文件(Serwist inject) | 0.5h |
| **C-PWA-1.5** | `src/components/pwa/InstallPrompt.tsx` 客户端组件 | 1h |
| **C-PWA-1.6** | `src/components/layout/app-shell.tsx` 集成 InstallPrompt | 0.5h |
| **C-PWA-1.7** | `src/app/offline/page.tsx` offline fallback + i18n 14 keys | 0.5h |

**离线缓存策略**(Serwist runtimeCaching):
- 菜单图片(`/store/menu`、`/api/store/menu`):StaleWhileRevalidate, 7 天
- 商品图片(`/product-media/...`):CacheFirst, 30 天
- 静态资源(`/_next/static/...`):CacheFirst, 30 天
- 业务 API:StaleWhileRevalidate, 5 分钟

### Sprint 2: Customer PWA(2 周)

**Commit 计划(5 commits)**:

| Commit | 文件 | 估时 |
|---|---|---|
| **C-PWA-2.1** | `scripts/migrate-customer-favorites.sql` 建表 + `migrate.sql` 加 2 字段 | 0.5h |
| **C-PWA-2.2** | `src/lib/customer-identity.ts` 设备指纹 + cookie 工具 | 1h |
| **C-PWA-2.3** | `src/app/api/customer/favorites/route.ts` GET/POST/DELETE | 1h |
| **C-PWA-2.4** | `src/app/[locale]/store/[slug]/page.tsx` 移动端 first 优化(已有) | 0.5h |
| **C-PWA-2.5** | `src/components/store/AddToFavorites.tsx` + i18n 7 keys | 1h |

**`customer_favorites` 表**:
```sql
create table if not exists public.customer_favorites (
  id varchar(36) primary key default gen_random_uuid(),
  device_id varchar(64) not null,  -- 设备指纹(V1 替代 user_id)
  business_id varchar(36) not null references public.businesses(id),
  created_at timestamptz not null default now(),
  unique (device_id, business_id)
);
create index customer_favorites_device_idx on public.customer_favorites (device_id);
```

### Sprint 3: Owner PWA(2 周)

- 简化 owner dashboard 卡片布局(mobile first)
- AI 日报推送时间线(竖向时间流)
- 一键操作按钮(回评 / 改价 / 补库存)
- 依赖:P0-S3 RBAC(路由守卫)
- **V1 不做,推后**

### Sprint 4: Push Notification(2 周)

- `lib/web-push.ts` 封装 VAPID
- `push_subscriptions` 表(端点 + 加密 p256dh / auth)
- `service-worker.js` push handler
- AI Agent 主动调用(规则引擎 V1 + AI V2)
- 客户通知(收藏餐厅后 → 新品 / 优惠 push)
- **V1 不做,推后**

### Sprint 5: 优化(1 周)

- 性能:Lighthouse 90+
- 安全:CSP / 域验证 / 速率限制
- 离线:关键页 cache-only
- 监控:推送到达率 / 安装率
- **V1 不做,推后**

---

## 4. 风险与缓解

| 风险 | 缓解 |
|---|---|
| WSL launcher 解析 bash 失败(之前踩过) | 用 `C:\Program Files\Git\bin\bash.exe` 真实路径 |
| Serwist 与 Next.js 16 兼容问题 | 锁版本,准备 fallback `next-pwa@5.x`(archived 但稳定) |
| Service Worker 缓存旧版导致更新失败 | Serwist 默认 skipWaiting + clientsClaim,版本号在 manifest |
| 子域名 SSL 需 Cloudflare(没接) | PWA Sprint 1 用 `app.roveframe.com/store/manifest` 单域测试,Sprint 2-3 同步 P1.5 Cloudflare |
| Push Notification 在 iOS Safari 16.4+ 才支持 | 文档说明,Android Chrome 优先 |
| VAPID 私钥泄漏 | 加密存 settings 表(已有 lib/crypto) |
| Customer device_id 唯一性 | SHA-256(IP + UA + accept-language) 组合,fallback UUID v4 in localStorage |

---

## 5. 部署 / 配置依赖(必须由你做)

PWA Sprint 1 不需要外部凭据。

但 PWA Sprint 4 (Push Notification) 需要:
1. VAPID 密钥对(我用 `web-push generateVAPIDKeys()` 生成)
2. 申请 Web Push 协议(免费,无审批)

---

## 6. 不在 Sprint 1 范围(明确推后)

- ❌ Owner PWA(Sprint 3,依赖 P0-S3 RBAC)
- ❌ Push Notification(Sprint 4)
- ❌ 性能优化(Sprint 5)
- ❌ React Native(未来,代码结构预留 service layer)

---

## 7. 验收清单(Sprint 1 完成时)

- [ ] `pnpm ts-check` 0 error
- [ ] Chrome DevTools → Application → Manifest 看到完整 manifest
- [ ] Chrome DevTools → Application → Service Workers 看到 `sw.js` activated
- [ ] Lighthouse PWA score ≥ 90
- [ ] 浏览器地址栏右侧出现"安装"图标
- [ ] 装上后启动是 standalone 模式(无浏览器地址栏)
- [ ] offline 模式打开 `/zh/store` 显示 offline 页面
- [ ] i18n Install Prompt 文案(en/zh/es)

---

## 8. commit 清单(预演,今晚实际只到 C-PWA-1.7 + C-PWA-2.1-2.3 起步)

```
docs/V1-PWA-Integration.md                          ← 本文档
package.json + pnpm-lock.yaml                      ← C-PWA-1.1
next.config.ts                                     ← C-PWA-1.2
src/app/manifest.ts                                ← C-PWA-1.3
src/app/sw.ts                                      ← C-PWA-1.4
src/components/pwa/InstallPrompt.tsx               ← C-PWA-1.5
src/components/layout/app-shell.tsx                ← C-PWA-1.6
src/app/offline/page.tsx                           ← C-PWA-1.7
messages/{en,zh,es}.json                          ← i18n
scripts/migrate-customer-favorites.sql             ← C-PWA-2.1
src/lib/customer-identity.ts                       ← C-PWA-2.2
src/app/api/customer/favorites/route.ts            ← C-PWA-2.3
```

---

## 9. 跟 V2 路线图对账

| V2 阶段 | 跟 PWA 关系 |
|---|---|
| P0-S2 完整版(已做) | ✅ 兼容,tenant_id 隔离 |
| P0-S3 RBAC | ⚠️ Sprint 3 依赖 |
| P1.5 install.sh + Cloudflare | ⚠️ Sprint 2-3 子域路由 |
| P1 AI 生成 | ❌ 无关 |
| P2 商业化(Stripe) | ❌ 无关 |
| P2 S13-14 AI Planning | ⚠️ Sprint 4 主动推送依赖 |

**结论**:PWA Sprint 1 立即可做;Sprint 2-3 推后到 P0-S3 + P1.5;Sprint 4 推后到 P2 S13-14。

---

*本文档 + PWA Sprint 1 + Sprint 2 起步今晚交付。明天按验收清单跑测试 + 修复 issue。*
