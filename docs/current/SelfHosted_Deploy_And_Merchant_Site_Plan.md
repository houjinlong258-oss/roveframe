# 内置数据库部署 + Agent 生成官网 —— 方案与实施记录

状态：方案已定，实施中。
用户决定：P1 + P2 + P3 全做；边缘代理**两条并存**（内置部署路径用 Caddy，仓库已有的
`src/lib/deployment/generator.ts` 的 nginx + certbot 生成器保持不动）。

---

## 0. 需求原文

> 能不能自动配置数据库，不需要数据库密码什么的内置一个呢？用户只需要在服务器里输入部署代码，
> 一键自动部署全部需要的环境，自动接上数据库，无脑化。然后加入一个功能：用户进入 webui 可以
> 让里面 agent 根据自己店铺的信息做一个官网，给 AI 域名和证书他自己就配置上了，然后这官网可以
> 链接后台和下单以及预约。下单直接就进了那个点单的 H5 小程序了。

拆成三件事：

| 编号 | 需求 | 本文档章节 |
|---|---|---|
| P1 | 内置数据库 + 一条命令部署全部环境 | §2 |
| P2 | Agent 按店铺信息生成官网，官网链后台/下单/预约，下单进顾客端 PWA | §3 |
| P3 | 给域名 + 证书，自动配置 | §4 |

---

## 1. 现状核实（全部为本次实测证据）

| 事实 | 证据 |
|---|---|
| 当前 compose 强制要求现成 Supabase 凭据，没有 DB 容器 | `docker-compose.yml:105-108`，注释明写 "external Supabase; no DB container needed" |
| 已有开机自动迁移，用 `pg` + `DATABASE_URL` 执行 12 个 SQL 文件 | `src/lib/migration.ts:118-133`，调用点 `src/server.ts:99` |
| 迁移链清单（单一事实源） | `src/lib/migration.ts:23-64` |
| 全库只需要 1 个 PG 扩展 | `scripts/migrate-business-tables.sql:15`（`create extension if not exists vector`） |
| 全仓库只有 1 处 `createClient`，且没有任何浏览器端代码直连数据库 | `src/storage/database/supabase-client.ts:1`；`src/components`、`src/app/**.tsx` grep `supabase-client\|supabase-js` 命中 0 |
| PostgREST 之外还依赖 GoTrue 与 Storage API | `src/lib/auth.ts:100`（`auth.admin.createUser`）、`src/app/api/auth/invite/route.ts:76`、`src/app/api/upload/route.ts:17,57,63` |
| 顾客端 PWA（点餐）完整，但只能靠不透明二维码 token 定位租户 | `src/lib/storefront.ts:16-31`；无 token 直接 404（`src/app/api/store/menu/route.ts:20-21`） |
| 预约**没有**公开接口，三个 handler 全部要求登录 | `src/app/api/reservations/route.ts:19,75,94` |
| Agent 已经拿到完整经营快照 | `src/lib/business-context.ts:34-90` |
| 对外 origin 已有单一解析口 | `src/lib/app-origin.ts:13` |
| 仓库已有一个部署产物生成器（nginx + certbot），并已接进企业工具 | `src/lib/deployment/generator.ts:1-16`、`src/lib/enterprise/tool-runtime.ts:164` |
| 设置页 9 个分组，没有"官网" | `src/app/[locale]/settings/page.tsx:562-571` |
| 本机 Docker 29.4.2 / compose v5.1.3；**Docker Hub 不可达** | `docker manifest inspect postgres:16-alpine`、`caddy:2-alpine` 均 `registry-1.docker.io` 超时 |

### 1.1 本机无法验证的部分（必须在目标服务器上验证）

- 5 个新镜像能否拉取（本机 registry 超时；国内网络需要镜像加速地址）。
- 首启顺序：db healthy → GoTrue/Storage 自迁移 → web 的 `autoMigrate` → `/api/health` 200。
- Caddy 能否真正签下证书（需要公网 IP、DNS 已指向、80/443 可达）。

---

## 2. P1 —— 内置数据库 + 一条命令

### 2.1 为什么不是"只塞一个 Postgres"

代码走的是 HTTP 协议而不是一个 DSN，三个前缀在同一个 origin 上：

| 前缀 | 服务 | 代码里的使用点 |
|---|---|---|
| `/rest/v1` | PostgREST | 全仓库 `.from()` / `.rpc()` |
| `/auth/v1` | GoTrue | `src/lib/auth.ts:100`、`src/app/api/auth/invite/route.ts:76` |
| `/storage/v1` | Storage API | `src/app/api/upload/route.ts:17,57,63` |

少任何一个都必须改 `src/`，那是大重构，违反项目纪律。因此内置的是**一整套 Supabase 开源栈**，
`src/` 零改动。

### 2.2 容器清单（`docker-compose.selfhosted.yml`，叠加在现有 compose 之上）

| 服务 | 镜像 | 作用 |
|---|---|---|
| `db` | `supabase/postgres`（自带 pgvector 与 supabase 角色） | 数据库 |
| `rest` | `postgrest/postgrest` | `/rest/v1` |
| `auth` | `supabase/gotrue` | `/auth/v1` |
| `storage` | `supabase/storage-api` | `/storage/v1` |
| `gateway` | `nginx:alpine` | 单 origin 汇聚 + 边界收敛 |
| `edge` | `caddy:2-alpine` | 80/443、自动证书（P3） |

### 2.3 边界收敛（比 Supabase 云更安全）

因为**没有任何浏览器代码直连 PostgREST**（§1 已核实），网关可以：

- `/storage/v1/object/public/**` 公开（商品图/视频）。
- `/auth/v1/verify` 公开（邮件确认链接需要）。
- `/rest/v1`、`/auth/v1`、`/storage/v1`（写）**只允许 Docker 内网**，公网 403。

Supabase 云上 `/rest/v1` 永远公开，只有 anon key + RLS 兜底；自建后这一面直接关掉。

`COZE_SUPABASE_URL` = 自己的公网 origin，因此 `getPublicUrl()` 落库的图片地址天然可达，且无跨域。

### 2.4 密钥生成（零依赖）

`anon` / `service_role` key 就是 HS256 签名的 JWT（`{"role":"anon|service_role","iss":"supabase"}`），
用 Node 内置 `crypto` 就能签。`scripts/gen-deploy-secrets.mjs` 生成：
`POSTGRES_PASSWORD`、`JWT_SECRET`、`ANON_KEY`、`SERVICE_ROLE_KEY`、`ENCRYPTION_SECRET`、
`ROVEAGENT_API_KEY`、`ROVEAGENT_APPROVAL_SECRET`（后两者必须不同，`roveagent/api/app.py` 会拒绝相同值）。

### 2.5 一条命令

```
bash install.sh            # 或在服务器上 curl -fsSL <repo>/install.sh | bash
```

步骤：预检（docker/compose/端口/内存）→ 选镜像加速地址 → 生成 `docker/deploy.env`(600)
→ `docker compose -f docker-compose.yml -f docker-compose.selfhosted.yml up -d --build`
→ 轮询 `/api/health` 直到 200 → 用 GoTrue admin API 建首个 owner → 打印网址与账号。

---

## 3. P2 —— Agent 生成官网

### 3.1 数据

新增一张表（走 `src/lib/migration.ts` 迁移链，幂等）：

```
public_sites(
  id, tenant_id, business_id,
  slug text unique,               -- 路径 /site/<slug> 与 <slug>.<SITE_DOMAIN>
  enabled boolean default false,  -- 未发布不对外
  theme jsonb,                    -- 配色/字体
  content jsonb,                  -- Agent 写出的分区文案
  seo jsonb,
  custom_domain text unique,
  domain_status text,             -- none|pending_dns|issuing|active|error
  web_order_qr_id uuid,           -- 复用顾客端 PWA 的"网页桌号"
  published_at, created_at, updated_at
)
```

### 3.2 "下单直接进顾客端 PWA" —— 虚拟桌号

顾客端 PWA 已完整（购物车/小费/落单/幂等键，见 `src/app/[locale]/store/page.tsx`），只认二维码 token。
给每个商家插一行 `table_no='WEB'` 的 `store_qr_codes`，官网「立即下单」链到
`/{locale}/store?token=<那一行>`。

**顾客端 PWA 一行不改**，服务端计价、租户隔离、幂等全部复用。

### 3.3 预约

现状没有公开接口。新增 `POST /api/site/[slug]/reservations`：
租户/商家**只从 slug 服务端解析**（绝不接受客户端传 tenant_id），复用现有 `reservations` 表，
复用 `src/lib/rate-limit-contract.ts` 限流，字段白名单校验。

### 3.4 Agent 生成

新增企业工具 `site.generate_draft`（读 `getBusinessContext()` + 商品 + settings → 调
`invokeChat('content', …)` → 严格 JSON 校验 → 写入 `content`/`theme`，`enabled=false`）与
`site.publish`（高风险，走既有 EnterpriseToolGate 审批）。

后台新增 `/{locale}/website` 页：预览、重新生成、编辑文案、绑定域名、发布。三语文案同步
（`tests/i18n-parity.test.ts` 会守）。

---

## 4. P3 —— 域名 + 证书

`edge`（Caddy）配置：

```
{
  on_demand_tls { ask http://web:5000/api/site/authorize }
}
<域名> {
  tls { on_demand }
  reverse_proxy gateway:80
}
```

> **更正（Phase 19）**：这段原文写的是 `/api/site/domain/authorize`，而那个路由**不存在** ——
> 真实实现是 `src/app/api/site/authorize/route.ts`。Caddy 的 `ask` 契约是"非 2xx 即拒绝"，
> 所以 404 等于对**每个**域名拒绝签发，商家绑定自定义域名后永远拿不到证书，且没有任何
> 报错指向这里。Caddyfile、`docker-compose.selfhosted.yml` 的注释与本文都已改正，
> 并加了接线守卫（`tests/site-certificate-authorization.test.ts`：解析 ask 路径 →
> 去文件系统确认 route.ts 存在 → 确认它在公开白名单里）。

`POST /api/site/authorize` 只在 Host 命中 `public_sites.custom_domain` 且状态允许时才 200，
否则 404（fail-closed）。这样别人的域名无法借我们的服务器签证书。

`<slug>.<SITE_DOMAIN>` 走同一套；没有 DNS API token 时用 HTTP-01（要求该主机名已指向本服务器）。

**已明确不做的**：不 SSH 到用户服务器、不代持用户 DNS。`src/lib/deployment/generator.ts`
（商家自部署路径，nginx + certbot）保持原样，两条路各管一段。

---

## 5. 实施顺序

| 阶段 | 交付 | 验证方式 |
|---|---|---|
| P1 | compose overlay、网关 conf、密钥生成器、`install.sh`、owner 引导 | `docker compose config` 解析通过；密钥生成器可跑；环境变量白名单守卫测试 |
| P2 | 迁移、slug/host 解析、官网页、公开预约接口、Agent 工具、后台页、三语 | 本地容器内实测：官网 200、下单跳转带 token、预约落库、限流生效 |
| P3 | Caddyfile、authorize 接口、域名绑定 UI、状态机 | 接口层负向对照：未登记域名必须 404 |
