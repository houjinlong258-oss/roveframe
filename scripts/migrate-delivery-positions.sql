-- ---------------------------------------------------------------------------
-- Phase 18 / P18-10 —— 骑手位置上报（顾客端"骑手在哪 / 大约什么时候到"）
--
-- 设计要点：
--
-- 1. **本表刻意不加指回 `delivery_orders` 的外键，更没有级联删除。**
--    两个理由：
--      a. 位置行必须能被保留期任务**独立**删除（见
--         src/lib/delivery-position.ts 的 purgeOldPositions）。有了级联，删除父行
--         会连带删掉子行，删除动作就不再由"保留期"这一个地方说了算。
--      b. 更严重的是审计：订单被清掉（含 /api/settings/wipe）时，级联会**静默**
--         抹掉"这名骑手当时在哪"的全部记录 —— 而那正是这张表存在的唯一理由。
--         宁可在清理订单时剩下一批没有父行的位置行（由保留期任务在 24 小时内
--         按时间删掉），也不能让"看不见的删除"发生。
--    代价是 delivery_id 可能指向已不存在的单：读取路径一律先按 delivery_id 查
--    位置、再按 token 定租户，取不到父行就是 404，不需要外键来保证正确性。
--
-- 2. **只存事实，不存推导值**：lat/lng/accuracy_m 是骑手设备上报的原始值，
--    距离与 ETA 一律在读取时按当时的参数计算（src/lib/delivery-position.ts）。
--    把 ETA 存进表里，事后就无法复核"当时是怎么算出来的"。
--
-- 3. 两条索引各服务一个查询，不多建：
--      · (delivery_id, recorded_at desc) —— 顾客端每次轮询只取最新一条
--      · (recorded_at)                  —— 保留期清理按时间删过期行
-- ---------------------------------------------------------------------------

create table if not exists public.delivery_positions (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null,
  business_id varchar(36) not null,
  delivery_id varchar(36) not null,
  staff_id varchar(36) not null,
  lat numeric(9,6) not null,
  lng numeric(9,6) not null,
  accuracy_m numeric(7,1),
  recorded_at timestamptz not null default now()
);

-- 取某单最新位置
create index if not exists delivery_positions_delivery_idx
  on public.delivery_positions (delivery_id, recorded_at desc);

-- 保留期清理专用（见 src/lib/scheduler.ts 里的清理调用）
create index if not exists delivery_positions_recorded_idx
  on public.delivery_positions (recorded_at);

-- ---------------------------------------------------------------------------
-- 配送目标点坐标（顾客地址的经纬度）。
--
-- 现状：`delivery_orders.address_line` 是**文本**地址，本项目没有地理编码服务，
-- 文本换不出坐标。因此这两列的唯一诚实来源是顾客本人设备在下单时给出的定位
-- （由顾客端下单链路写入，不在本次改动范围内）。
--
-- 取不到就是 NULL，此时 /api/store/deliveries/[id]/track 返回 `estimate: null`
-- 并只展示 promised_at —— 绝不拿一个编出来的距离糊弄顾客
-- （`delivery_orders` 的既有列里没有任何坐标，见 migrate-delivery-orders.sql）。
-- ---------------------------------------------------------------------------

alter table public.delivery_orders
  add column if not exists dest_lat numeric(9,6);

alter table public.delivery_orders
  add column if not exists dest_lng numeric(9,6);
