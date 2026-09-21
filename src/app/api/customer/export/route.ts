import { NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { resolveCustomerSession } from '@/lib/customer-auth';
import { writeRequiredAudit } from '@/lib/audit';

/**
 * 顾客自己的数据导出：`GET /api/customer/export`。
 *
 * ===========================================================================
 * 与 `src/app/api/staff/export/route.ts` 同一条隐私义务，同一套约束
 * ===========================================================================
 *
 * 员工有权导出自己的档案/考勤，顾客同样有权导出自己的账号数据 —— 对面向海外市场
 * 的产品来说这是合规要求（数据可携带权），不是"顺手加的功能"。因此本文件逐条
 * 照抄员工导出的形态，而不是另发明一套：
 *
 * ## 1. 只能导出**自己**，账号 id 只来自会话
 *
 * 本路由**没有** `?account_id=`，也不读请求体：主体由
 * `resolveCustomerSession(request)` 解析（顾客 cookie → customer_sessions 行 →
 * customer_accounts 行）。只要存在一个查询参数能指定别人，它就是"导出任意顾客资料
 * 与地址簿"的接口 —— 而那种越权在读接口上比在写接口上更难发现。
 *
 * ## 2. 每一次导出都写审计，写不进去就不导出
 *
 * 与员工导出用的是同一个函数 `writeRequiredAudit`（src/lib/audit.ts:52）：它在写库
 * 失败时抛错，而不是像 `writeAudit` 那样 best-effort。本路由捕获后返回 **503**，
 * 且在审计落库**之前**不把任何一条数据交给调用方 ——
 * "读到了但没留痕"正是这类接口最不该出现的状态。
 * 审计只记**谁、什么时候、导出了几行**，绝不记内容。
 *
 * ## 3. 返回的是原始列，不是派生视图
 *
 * 地址簿给库里的列本身；订单给 `orders` 的列 + `delivery_orders.rider_status`
 * （页面上的派生字段不在这里重算，理由同员工导出：抄一份算法就会漂移）。
 *
 * ## 4. 被截断时必须说出来
 *
 * 订单部分的上限与 `/api/customer/orders` **相同（100）**，原因也在那边写了：
 * PostgREST 的 `in.(...)` 让 URL 随订单数无界增长。差别在于本接口**不假装完整** ——
 * 响应体里显式带 `orders_limit` / `orders_truncated`，下载到文件的顾客一眼能看出
 * "还有更早的订单没有包含在内"，而不是以为历史只有这 100 条。
 *
 * ## 5. 刻意**不含**两块数据，并且逐条写明理由
 *
 * `excluded` 数组是给读文件的顾客看的（不是给开发者看的注释）：
 *   · 收藏（customer_favorites）：那张表按 **device_id cookie** 分片
 *     （src/lib/customer-identity.ts），与账号没有关联列。把它塞进"账号数据导出"
 *     等于把另一个身份（可能是共用这台设备的另一个人）的数据混进来；
 *   · 会话（customer_sessions）：里面只有 token 的 sha256 摘要，把它导出到用户
 *     下载的文件里就是把凭据材料复制到库外，没有任何对顾客有用的信息。
 *
 * ## 订单归属规则与 /api/customer/orders 一致（这是刻意的复制）
 *
 * 顾客与订单之间没有外键：唯一天然的关联键是下单时填的收货手机号
 * （`delivery_orders.recipient_phone`），匹配用**精确相等**，不做格式归一化 ——
 * 归一化要一条唯一规则，而在"猜两边格式"的路径上误配的后果是把别人的订单交出去。
 *
 * 为什么不把它抽成公共函数：那条规则眼下被 `tests/customer-auth.test.ts:264-268`
 * 按**源码**断言在订单路由上（`.eq('recipient_phone', phone)` 等），抽走会让那条守卫
 * 变成空断言；而把订单路由改写成调用公共函数，属于本次任务范围之外的重构。
 * 因此这里照抄查询形态并留下这条注释：**改其中一处必须同时改另一处**。
 * 与员工导出里"关怀记录可见性规则逐条照抄"是同一个取舍。
 */

/** 地址/档案的取数上限（与员工导出一致：导出是"取全量"，但仍要有上限）。 */
const MAX_ROWS = 2000;
/**
 * 订单上限：与 /api/customer/orders 的 MAX_ORDERS 相同（见文件头第 4 条）。
 * 两个数字不一致会出现"导出比页面多/少几条"这种无法解释的差异。
 */
const MAX_ORDERS = 100;

const ORDER_COLUMNS = 'id, order_no, channel, status, total, created_at';
/** 与 /api/customer/addresses 的 ADDRESS_COLUMNS 逐字相同。 */
const ADDRESS_COLUMNS = [
  'id', 'label', 'recipient_name', 'recipient_phone',
  'address_line', 'address_note', 'is_default', 'created_at',
].join(', ');

export interface ExportedCustomerAccount {
  id: string;
  email: string | null;
  phone: string | null;
  display_name: string | null;
  locale: string | null;
  marketing_opt_in: boolean | null;
  status: string | null;
  created_at: unknown;
  last_login_at: unknown;
}

export interface ExcludedSection {
  section: string;
  reason: string;
}

export interface CustomerDataExport {
  exported_at: string;
  account: ExportedCustomerAccount;
  addresses: Record<string, unknown>[];
  orders: Record<string, unknown>[];
  orders_limit: number;
  orders_truncated: boolean;
  excluded: ExcludedSection[];
}

/**
 * 组装导出体。**纯函数**：只做整形与计数，不碰库。
 *
 * 抽成可导出函数是为了它能被**执行**验证（与员工导出的 `mergeVisibleCareNotes`
 * 同一形态）：这里做错的地方全都不会报错 ——
 *   · 订单被截断却不置 `orders_truncated`（顾客以为拿到了全部历史）；
 *   · 忘了带 `excluded`（顾客以为"我的数据里没有收藏"而不是"收藏不在这个口径里"）。
 */
export function buildCustomerExport(input: {
  exportedAt: string;
  account: ExportedCustomerAccount;
  addresses: Record<string, unknown>[];
  orders: Record<string, unknown>[];
}): CustomerDataExport {
  return {
    exported_at: input.exportedAt,
    account: input.account,
    addresses: input.addresses,
    orders: input.orders,
    orders_limit: MAX_ORDERS,
    // 取到上限就说明"很可能还有更早的"（恰好等于上限时同样按截断处理：
    // 宁可提示多一次，也不要让顾客以为历史正好 100 条）。
    orders_truncated: input.orders.length >= MAX_ORDERS,
    excluded: [
      {
        section: 'favorites',
        reason: 'favorites are bound to the device cookie (customer_favorites.device_id), not to this account',
      },
      {
        section: 'sessions',
        reason: 'session rows contain credential material (token hashes) and are not part of your personal data',
      },
    ],
  };
}

/** 订单行 → 导出形态：与 /api/customer/orders 的 toOrder 一致（total 从 numeric 转数字）。 */
function toExportedOrder(row: Record<string, unknown>, riderStatus: string | null) {
  return {
    id: String(row.id),
    order_no: String(row.order_no ?? ''),
    channel: String(row.channel ?? ''),
    status: String(row.status ?? ''),
    total: Number(row.total ?? 0),
    created_at: row.created_at ?? null,
    rider_status: riderStatus,
  };
}

export async function GET(request: Request) {
  const session = await resolveCustomerSession(request);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const client = getSupabaseClient();

  // ---- 档案 --------------------------------------------------------------
  // 列清单里**只出现**可交给本人的列：口令摘要与 salt 不在其中，
  // 也不在任何其它查询里（本文件通篇不出现那两个列名，源码级断言见
  // tests/customer-account.test.ts）。
  const { data: accountRaw, error: accountError } = await client
    .from('customer_accounts')
    .select('id, email, phone, display_name, locale, marketing_opt_in, status, created_at, last_login_at')
    .eq('id', session.accountId)
    .eq('tenant_id', session.tenantId)
    .eq('business_id', session.businessId)
    .maybeSingle();
  if (accountError) {
    console.error('[customer/export] account read failed:', accountError.message);
    return NextResponse.json({ error: 'could not read your account' }, { status: 500 });
  }
  if (!accountRaw) {
    // 会话有效但账号行不在：按未登录处理（与 /api/customer/me 同一口径）
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const accountRow = accountRaw as Record<string, unknown>;

  // ---- 地址簿（只取本人） --------------------------------------------------
  const { data: addressesRaw, error: addressesError } = await client
    .from('customer_addresses')
    .select(ADDRESS_COLUMNS)
    .eq('account_id', session.accountId)
    .eq('tenant_id', session.tenantId)
    .eq('business_id', session.businessId)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(MAX_ROWS);
  if (addressesError) {
    console.error('[customer/export] address read failed:', addressesError.message);
    return NextResponse.json({ error: 'could not read your saved addresses' }, { status: 500 });
  }

  // ---- 订单（归属规则见文件头） --------------------------------------------
  const phone = (accountRow.phone ?? null) as string | null;
  const riderByOrderId = new Map<string, string | null>();

  if (phone) {
    const { data: deliveries, error: deliveriesError } = await client
      .from('delivery_orders')
      .select('order_id, rider_status')
      .eq('tenant_id', session.tenantId)
      .eq('business_id', session.businessId)
      // 精确相等：不归一化（理由见文件头）
      .eq('recipient_phone', phone)
      .order('created_at', { ascending: false })
      .limit(MAX_ORDERS);
    if (deliveriesError) {
      console.error('[customer/export] delivery read failed:', deliveriesError.message);
      return NextResponse.json({ error: 'could not read your orders' }, { status: 500 });
    }
    for (const row of (deliveries ?? []) as { order_id: string; rider_status: string | null }[]) {
      riderByOrderId.set(row.order_id, row.rider_status);
    }
  }

  let orders: Record<string, unknown>[] = [];
  const orderIds = [...riderByOrderId.keys()];
  if (orderIds.length > 0) {
    const { data: orderRows, error: ordersError } = await client
      .from('orders')
      .select(ORDER_COLUMNS)
      .eq('tenant_id', session.tenantId)
      .eq('business_id', session.businessId)
      .in('id', orderIds)
      .order('created_at', { ascending: false });
    if (ordersError) {
      console.error('[customer/export] order read failed:', ordersError.message);
      return NextResponse.json({ error: 'could not read your orders' }, { status: 500 });
    }
    // select 的列清单是运行时拼的字符串，supabase-js 因此把返回类型收敛成
    // "字符串或错误"而不是具体行形状；显式收窄一次，不把 any 扩散出去。
    orders = ((orderRows ?? []) as unknown as Record<string, unknown>[]).map((row) =>
      toExportedOrder(row, riderByOrderId.get(String(row.id)) ?? null));
  }

  const addresses = (addressesRaw ?? []) as unknown as Record<string, unknown>[];
  const body = buildCustomerExport({
    exportedAt: new Date().toISOString(),
    account: {
      id: String(accountRow.id),
      email: (accountRow.email ?? null) as string | null,
      phone,
      display_name: (accountRow.display_name ?? null) as string | null,
      locale: (accountRow.locale ?? null) as string | null,
      marketing_opt_in: (accountRow.marketing_opt_in ?? null) as boolean | null,
      status: (accountRow.status ?? null) as string | null,
      created_at: accountRow.created_at ?? null,
      last_login_at: accountRow.last_login_at ?? null,
    },
    addresses,
    orders,
  });

  try {
    await writeRequiredAudit({
      tenantId: session.tenantId,
      // 顾客不进 users 表：可追溯的标识就是顾客账号 id（来自会话，客户端无从指定）
      actorId: session.accountId,
      action: 'customer.export',
      entity: 'customer_accounts',
      entityId: session.accountId,
      after: {
        business_id: session.businessId,
        address_rows: addresses.length,
        order_rows: orders.length,
        orders_truncated: body.orders_truncated,
        // 只记条数，绝不记内容：审计表是更宽的可见面。
      },
    });
  } catch (error) {
    console.error(
      '[customer/export] required audit write failed:',
      error instanceof Error ? error.message : error,
    );
    // 审计写不进去 → 一个字节都不给（见文件头第 2 条）。
    return NextResponse.json({ error: 'security audit unavailable' }, { status: 503 });
  }

  return NextResponse.json(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // 文件名里的账号 id 来自会话，客户端无从注入。
      'Content-Disposition': `attachment; filename="roveframe-customer-export-${session.accountId}.json"`,
      // 个人数据不得被中间缓存（CDN / 代理 / 浏览器磁盘缓存）留存。
      'Cache-Control': 'no-store',
    },
  });
}
