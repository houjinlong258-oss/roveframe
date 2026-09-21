/**
 * Phase 18 三端 PWA 的数据层 —— **真实 HTTP 客户端**。
 *
 * ## 这个文件的定位
 *
 * 它替换掉原型里的 `In-Browser High-Fidelity Mock Engine`。方法名、参数、返回类型
 * 与原型**逐字一致**，所以 `src/components/{customer,staff,owner}/**` 里那 350KB UI
 * 一行都不用改 —— 只换数据来源。
 *
 * 这是有意的设计：把"接口形态"与"数据来源"分开，前端可以独立演进，
 * 后端也可以独立演进，中间只有这一个文件需要同时理解两边。
 *
 * ## 三处必须由这一层吸收的差异
 *
 * 原型的类型定义与后端实际字段有出入。放在这里对齐，而不是去改 UI：
 *
 *   1. `rider_status`：UI 用 `'unclaimed'`，后端用 `'pending'`（见
 *      `src/lib/delivery.ts` 的 `RIDER_STATUSES` 白名单）。
 *   2. `CareSignal.kind`：UI 用 `'consecutive_days'` / `'missed_clock'`，
 *      后端信号键是 `'rest'` / `'missing_punch'`。
 *   3. 骑手遥测（`RiderInfo.battery_level` / `temperature` / `speed_kmh` /
 *      `health_certified` 等）**没有数据源**，本层不做任何编造 —— 缺就是缺，
 *      相关字段不返回，由 UI 决定怎么降级。这一条是硬要求：
 *      原型里那些数字是写死的，而它们会让顾客以为自己在看实时配送状态。
 *
 * ## 失败一律显式
 *
 * 所有错误都抛出带 `code` 与 `error` 的 `PwaApiError`，因为原型组件就是按
 * `e.code === 'already_claimed'` / `e.error` 处理的。不做静默回落 ——
 * 项目纪律里写明"宁可 fail-closed"。
 */

import type {
  CareNote,
  CareResource,
  CareSignal,
  CustomerAccount,
  CustomerAddress,
  CustomerOrderSummary,
  DeliveryOrderRequest,
  DeliveryOrderResponse,
  DineInOrderRequest,
  DineInOrderResponse,
  KitchenPhoto,
  ReservationRequest,
  ReservationResponse,
  SiteConfigResponse,
  StaffAttendanceActionResponse,
  StaffAttendanceRecord,
  StaffDeliveriesResponse,
  StaffDeliveryItem,
  StaffMeResponse,
  StaffReservationItem,
  StaffShift,
  StoreMenuResponse,
  TeamAttendanceAuditRecord,
  TeamMember,
} from '../types';

/** 后端错误码 → UI 需要的形态。原型按 `e.code` / `e.error` 分支，因此两个字段都要有。 */
export class PwaApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'PwaApiError';
    this.status = status;
    this.code = code;
    /** 原型读的是 `e.error`，不是 `e.message`。两个都给，避免它退化成通用提示。 */
    (this as unknown as { error: string }).error = message;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** 下单类接口需要，用于重试幂等。 */
  idempotencyKey?: string;
  /** 公开接口用 token/slug 定租户，不需要会话。 */
  anonymous?: boolean;
}

let idempotencyCounter = 0;

/**
 * 生成一个幂等键。形态受后端 `isValidIdempotencyKey` 约束：
 * `/^[A-Za-z0-9._:-]{8,128}$/`。
 *
 * 用 `crypto.randomUUID()`（浏览器与 Node 都有）而不是 Math.random：
 * 键冲突会让两张不同的单撞成一张，不是可以碰运气的地方。
 */
export function newIdempotencyKey(prefix = 'pwa'): string {
  idempotencyCounter += 1;
  const uuid = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${idempotencyCounter}`;
  return `${prefix}:${uuid}`;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      // 商家会话与顾客会话都是 HttpOnly cookie。跨源部署会在这一步失败，
      // 而这正是"同源接入"这个决定要避免的问题。
      credentials: 'include',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error) {
    throw new PwaApiError(0, 'network_error', error instanceof Error ? error.message : 'network error');
  }

  if (response.status === 204) return undefined as T;

  let payload: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      // 不是 JSON（例如网关返回的 HTML 错误页）。不要假装它是数据。
      if (!response.ok) {
        throw new PwaApiError(response.status, 'invalid_response', `HTTP ${response.status}`);
      }
      throw new PwaApiError(response.status, 'invalid_json', 'the server did not return JSON');
    }
  }

  if (!response.ok) {
    const body = (payload ?? {}) as { error?: string; code?: string; detail?: string; shortfall?: number };
    throw new PwaApiError(
      response.status,
      body.code ?? `http_${response.status}`,
      body.detail ?? body.error ?? `HTTP ${response.status}`,
    );
  }

  return payload as T;
}

// ---------------------------------------------------------------------------
// 差异吸收：后端 rider_status → UI rider_status
// ---------------------------------------------------------------------------

/**
 * 后端 `pending` 在 UI 里叫 `unclaimed`。映射放在这一处，
 * 不去改 UI 的联合类型，也不去改后端的白名单 —— 两边各自的名字都已经在用了。
 */
function toUiRiderStatus(value: unknown): 'unclaimed' | 'claimed' | 'picked_up' | 'delivered' {
  if (value === 'claimed' || value === 'picked_up' || value === 'delivered') return value;
  return 'unclaimed';
}

function toDeliveryItem(raw: Record<string, unknown>): StaffDeliveryItem {
  return {
    id: String(raw.id ?? ''),
    order_no: String(raw.order_no ?? ''),
    address_line: String(raw.address_line ?? ''),
    recipient_phone: String(raw.recipient_phone ?? ''),
    recipient_name: raw.recipient_name === undefined ? undefined : String(raw.recipient_name),
    total: Number(raw.total ?? 0),
    created_at: String(raw.created_at ?? ''),
    promised_at: String(raw.promised_at ?? ''),
    items_summary: String(raw.items_summary ?? ''),
    rider_status: toUiRiderStatus(raw.rider_status),
    notes: raw.notes === undefined ? undefined : String(raw.notes),
    // 刻意不填 rider / coordinates：后端没有这两个数据源。
    // 原型里它们是写死的演示数据，填上去等于让员工看到假的实时位置。
  };
}

/** 后端信号键 → UI 的信号类型联合。 */
function toUiSignalKind(value: unknown): CareSignal['kind'] {
  switch (value) {
    case 'rest': return 'consecutive_days';
    case 'missing_punch': return 'missed_clock';
    case 'birthday':
    case 'overtime':
    case 'long_shift':
    case 'anniversary':
      return value;
    default:
      // 未知信号一律当"需要人看一眼"处理，而不是丢掉 —— 静默丢弃会让
      // 老板永远不知道有一条提醒存在过。
      return 'consecutive_days';
  }
}

// ---------------------------------------------------------------------------
// 7.1 顾客端
// ---------------------------------------------------------------------------

/**
 * 顾客账号的完整形态。
 *
 * `CustomerAccount`（src/types/index.ts:147）只有 id / email / display_name / phone，
 * 而 `/api/customer/me` 还返回 `locale` 与 `marketing_opt_in`。那个文件本轮禁改
 * （与下面的 `StaffDataExport` 同一个理由），因此在数据层把它扩展出来：
 * 账号面板要回显语言与订阅开关，缺这两个字段会让"保存成功但界面没变"看起来像 bug。
 */
export interface CustomerAccountSettings extends CustomerAccount {
  /** en | zh | es：服务端白名单三选一（不在表里一律 400，不静默回落）。 */
  locale: string;
  marketing_opt_in: boolean;
}

/**
 * 可编辑的账号字段。**没出现的字段服务端不动**（PATCH 语义）——
 * 因此这里刻意用可选字段而不是"整体覆盖"：整体覆盖会让一次只想改语言的请求
 * 顺手把手机号清空，而手机号是订单归属的匹配键（src/app/api/customer/orders）。
 */
export interface CustomerAccountPatch {
  display_name?: string;
  phone?: string;
  locale?: string;
  marketing_opt_in?: boolean;
}

/** 地址的局部编辑。同上：没出现的字段不动。 */
export interface CustomerAddressPatch {
  label?: string;
  recipient_name?: string;
  recipient_phone?: string;
  address_line?: string;
  address_note?: string;
  is_default?: boolean;
}

/**
 * `GET /api/customer/export` 的返回体（与 `StaffDataExport` 同一形态，
 * 定义在这里而不是 src/types/index.ts：那个文件本轮禁改）。
 *
 * 地址/订单刻意是**原始列**而不是页面上的派生形态：导出的定位是数据副本，
 * 派生字段的算法住在各自的接口里，抄一份过来就会漂移。
 * `label` / `address_note` 在库里可空，因此类型是 `string | null` 而不是 string ——
 * `CustomerAddress`（UI 契约）把它们写成 string 是原型的历史遗留。
 */
export interface CustomerDataExport {
  exported_at: string;
  account: {
    id: string;
    email: string | null;
    phone: string | null;
    display_name: string | null;
    locale: string | null;
    marketing_opt_in: boolean | null;
    status: string | null;
    created_at: string | null;
    last_login_at: string | null;
  };
  addresses: {
    id: string;
    label: string | null;
    recipient_name: string;
    recipient_phone: string;
    address_line: string;
    address_note: string | null;
    is_default: boolean;
    created_at: string;
  }[];
  orders: {
    id: string;
    order_no: string;
    channel: string;
    status: string;
    total: number;
    created_at: string | null;
    rider_status: string | null;
  }[];
  /** 订单部分的上限（与 /api/customer/orders 相同）。 */
  orders_limit: number;
  /** true = 还有更早的订单没包含在内。**不假装完整**（见导出路由的文件头）。 */
  orders_truncated: boolean;
  /** 刻意未包含的数据块及理由：给读文件的顾客看的，不是给开发者的备注。 */
  excluded: { section: string; reason: string }[];
}

/** `POST /api/customer/account/close` 的返回体：`completed` 恒为 false，见该路由文件头。 */
export interface CustomerAccountClosure {
  ok: boolean;
  status: string;
  revoked_sessions: number;
  deletion: { completed: boolean; note: string };
}

export const customerApi = {
  async getMenu(token = 'tbl_A1'): Promise<StoreMenuResponse> {
    const data = await request<{
      store: { name: string | null; intro: string; hours: string; currency: string };
      table: string | null;
      categories: string[];
      products: (Record<string, unknown> & { price: string | number })[];
    }>(`/api/store/menu?token=${encodeURIComponent(token)}`, { anonymous: true });

    return {
      store: {
        name: data.store.name ?? '',
        intro: data.store.intro ?? '',
        hours: data.store.hours ?? '',
        currency: data.store.currency ?? 'USD',
      },
      table: data.table,
      categories: data.categories ?? [],
      // 价格统一成字符串：UI 的 MenuItem.price 是 string，而 PostgREST 的
      // numeric 有时回 string 有时回 number，不统一会在 fmtCurrency 处出现 NaN。
      products: (data.products ?? []).map((p) => ({
        ...(p as unknown as StoreMenuResponse['products'][number]),
        price: String(p.price ?? '0'),
        description: String((p as { description?: unknown }).description ?? ''),
        image_url: String((p as { image_url?: unknown }).image_url ?? ''),
        video_url: ((p as { video_url?: unknown }).video_url ?? null) as string | null,
        sales_count: Number((p as { sales_count?: unknown }).sales_count ?? 0),
      })),
    };
  },

  async getSiteConfig(slug = 'grove-bistro'): Promise<SiteConfigResponse> {
    return request<SiteConfigResponse>(`/api/site/config?slug=${encodeURIComponent(slug)}`, { anonymous: true });
  },

  /**
   * 顾客端**不修改**站点配置 —— 那是老板端的事（`PATCH /api/website`）。
   * 原型把它放在 customerApi 里是为了演示方便。这里明确报错，
   * 而不是静默 no-op：静默会让调用方以为保存成功了。
   */
  async updateSiteConfig(): Promise<never> {
    throw new PwaApiError(405, 'not_a_customer_operation',
      'site configuration is edited in the owner portal, not from the customer app');
  },

  async createDineInOrder(req: DineInOrderRequest): Promise<DineInOrderResponse> {
    const data = await request<{ order: { order_no: string; total: number; id: string } }>(
      '/api/store/orders',
      {
        method: 'POST',
        anonymous: true,
        idempotencyKey: req.idempotency_key || newIdempotencyKey('dinein'),
        body: {
          token: req.token,
          items: req.items,
          note: req.notes ?? null,
          tip_amount: req.tip ?? 0,
          tip_percent: req.tip_rate ?? null,
        },
      },
    );
    return { order_no: data.order.order_no, total: Number(data.order.total), id: data.order.id };
  },

  async createDeliveryOrder(req: DeliveryOrderRequest): Promise<DeliveryOrderResponse> {
    return request<DeliveryOrderResponse>('/api/store/delivery-orders', {
      method: 'POST',
      anonymous: true,
      idempotencyKey: req.idempotency_key || newIdempotencyKey('delivery'),
      body: {
        token: req.token,
        items: req.items,
        recipient_name: req.recipient_name,
        recipient_phone: req.recipient_phone,
        address_line: req.address_line,
        address_note: req.address_note ?? '',
        customer_address_id: req.customer_address_id ?? null,
        notes: req.notes ?? '',
        // 只在顾客真的授权定位时带上；未授权则整个字段不出现，
        // 而不是传 null/0 —— 服务端把 null 视作"未提供"，与"提供了非法值"不同。
        ...(typeof req.dest_lat === 'number' && typeof req.dest_lng === 'number'
          ? { dest_lat: req.dest_lat, dest_lng: req.dest_lng }
          : {}),
      },
    });
  },

  /**
   * 后厨照片：**后端不存在，而且原型里的合规数字是写死的**。
   *
   * 明确返回空数组并留日志，而不是回落到演示数据 —— 见文件头第 3 条。
   * 需要这个功能时先建后端（照片上传 + 审核记录），再把页面接回来。
   */
  async getKitchenPhotos(): Promise<KitchenPhoto[]> {
    console.warn('[pwa-api] getKitchenPhotos: 后端未实现，返回空列表（不回落演示数据）');
    return [];
  },

  async createReservation(req: ReservationRequest): Promise<ReservationResponse> {
    return request<ReservationResponse>('/api/site/reservations', {
      method: 'POST',
      anonymous: true,
      body: {
        slug: req.slug,
        customer_name: req.customer_name,
        phone: req.phone,
        party_size: req.party_size,
        reserved_at: req.reserved_at,
        notes: req.notes ?? '',
      },
    });
  },

  async getCustomerAccount(): Promise<CustomerAccount | null> {
    try {
      const data = await request<{ account: CustomerAccount }>('/api/customer/me');
      return data.account;
    } catch (error) {
      // 401 = 没登录，是正常状态而不是错误。除此之外的错误必须冒泡。
      if (error instanceof PwaApiError && error.status === 401) return null;
      throw error;
    }
  },

  async customerLogin(identifier: string, pass: string, slug?: string): Promise<CustomerAccount> {
    const data = await request<{ account: CustomerAccount }>('/api/customer/auth/login', {
      method: 'POST',
      anonymous: true,
      body: { slug: slug ?? '', identifier, password: pass },
    });
    return data.account;
  },

  async customerRegister(input: {
    slug?: string; email?: string; phone?: string; password: string; display_name?: string; locale?: string;
  }): Promise<CustomerAccount> {
    const data = await request<{ account: CustomerAccount }>('/api/customer/auth/register', {
      method: 'POST',
      anonymous: true,
      body: {
        slug: input.slug ?? '',
        email: input.email ?? '',
        phone: input.phone ?? '',
        password: input.password,
        display_name: input.display_name ?? '',
        locale: input.locale ?? 'en',
      },
    });
    return data.account;
  },

  async customerLogout(): Promise<void> {
    await request<void>('/api/customer/auth/logout', { method: 'POST', anonymous: true });
  },

  async getCustomerOrders(): Promise<CustomerOrderSummary[]> {
    try {
      const data = await request<{ orders: CustomerOrderSummary[] }>('/api/customer/orders');
      return data.orders ?? [];
    } catch (error) {
      if (error instanceof PwaApiError && error.status === 401) return [];
      throw error;
    }
  },

  async getCustomerAddresses(): Promise<CustomerAddress[]> {
    try {
      const data = await request<{ addresses: CustomerAddress[] }>('/api/customer/addresses');
      return data.addresses ?? [];
    } catch (error) {
      if (error instanceof PwaApiError && error.status === 401) return [];
      throw error;
    }
  },

  async saveCustomerAddress(addr: Omit<CustomerAddress, 'id'>): Promise<CustomerAddress> {
    const data = await request<{ address: CustomerAddress }>('/api/customer/addresses', {
      method: 'POST',
      body: addr,
    });
    return data.address;
  },

  async deleteCustomerAddress(id: string): Promise<void> {
    await request<void>(`/api/customer/addresses?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  /**
   * 编辑一条已有地址（含"设为默认"）。
   *
   * 服务端返回的地址（含 `is_default`）是**这次写入的值**，并发下可能已被另一个
   * 请求改掉，所以调用方在成功后应重新 `getCustomerAddresses()` 取权威列表 ——
   * UI 就是这么做的。这里不替调用方做二次读取：那只是另一个同样会过期的快照。
   */
  async updateCustomerAddress(id: string, patch: CustomerAddressPatch): Promise<CustomerAddress> {
    const data = await request<{ address: CustomerAddress }>(
      `/api/customer/addresses?id=${encodeURIComponent(id)}`,
      { method: 'PATCH', body: patch },
    );
    return data.address;
  },

  /**
   * 编辑自己的账号资料。**没有 account id 参数**，这是有意的：
   * 服务端只改会话本人的那一行（路由不接受 `account_id`）。给这个方法加一个
   * id 参数，就等于向调用方许诺一个它做不到的能力。
   *
   * 401 在这里**照常抛出**（不像 `getCustomerAccount` 把 401 当"未登录"）：
   * 会话中途失效时用户必须看到"登录已过期"，静默返回 null 会让面板显示旧数据。
   */
  async updateCustomerAccount(patch: CustomerAccountPatch): Promise<CustomerAccountSettings> {
    const data = await request<{ account: CustomerAccountSettings }>('/api/customer/me', {
      method: 'PATCH',
      body: patch,
    });
    return data.account;
  },

  /**
   * 改密码：当前密码 + 新密码。服务端会**撤销除本会话以外的全部会话**，
   * 返回值里的 `revoked_sessions` 用来告诉用户"其它设备已被登出"。
   *
   * 当前密码错误是 401，响应体与服务端登录失败**逐字相同**（不区分原因），
   * 因此 UI 不能按 code 分支，只能显示服务端给的这一句。
   */
  async changeCustomerPassword(
    currentPassword: string,
    newPassword: string,
  ): Promise<{ revoked_sessions: number }> {
    return request<{ ok: boolean; revoked_sessions: number }>('/api/customer/auth/change-password', {
      method: 'POST',
      body: { current_password: currentPassword, new_password: newPassword },
    });
  },

  /**
   * 导出自己的顾客数据（资料 + 地址簿 + 订单）。
   *
   * **没有参数**，与 `staffApi.exportStaffData` 同一形态：服务端只导出会话本人
   * （账号 id 由会话解析，路由不接受 `?account_id=`）。
   *
   * 服务端回的是带 `Content-Disposition: attachment` 与 `Cache-Control: no-store`
   * 的 JSON，这里的 `request()` 读的仍然是 JSON 正文 —— 附件头只影响"把 URL 直接
   * 输进地址栏"时的行为。**不为此绕开 request()**：那样会丢掉统一的 PwaApiError
   * 语义（401 / 503 都要能被 UI 显示出来）。落盘由调用方用 Blob 触发。
   */
  async exportCustomerData(): Promise<CustomerDataExport> {
    return request<CustomerDataExport>('/api/customer/export');
  },

  /**
   * 注销账号：服务端只把 `status` 置为 `pending_deletion` 并撤销全部会话，
   * **不硬删除**（订单引用着这些记录，理由见该路由文件头）。
   *
   * `confirm: true` 是服务端强制要求的显式确认字段：缺它返回 400。
   * 因此这个方法是"不可逆动作"的入口，UI 必须先完成二次确认再调它。
   */
  async closeCustomerAccount(): Promise<CustomerAccountClosure> {
    return request<CustomerAccountClosure>('/api/customer/account/close', {
      method: 'POST',
      body: { confirm: true },
    });
  },
};

// ---------------------------------------------------------------------------
// 7.2 员工端
// ---------------------------------------------------------------------------

/**
 * `GET /api/staff/export` 的返回体。
 *
 * 类型定义在这里而不是 `src/types/index.ts`：那个文件本轮禁改，而这条链路是
 * 新的。放这里还有个好处 —— 它紧挨着唯一会产生它的方法，改接口时不会漏改类型。
 *
 * `attendance` / `shifts` 刻意是"原始列"而不是页面上的派生形态：
 * 导出的定位是数据副本，派生字段的算法住在各自的接口里，抄一份过来就会漂移。
 */
export interface StaffDataExport {
  exported_at: string;
  staff: {
    id: string;
    name: string;
    position: string | null;
    photo_url: string | null;
    phone: string | null;
    email: string | null;
    employment_type: string | null;
    hired_at: string | null;
    birthday: string | null;
    status: string | null;
  };
  attendance: {
    id: string;
    clock_in_at: string;
    clock_out_at: string | null;
    clock_in_source: string | null;
    note: string | null;
  }[];
  shifts: {
    id: string;
    starts_at: string;
    ends_at: string;
    role: string | null;
    note: string | null;
  }[];
  care_notes: {
    id: string;
    staff_id: string;
    kind: string;
    content: string;
    visibility: string;
    created_at: string | null;
  }[];
}

export const staffApi = {
  async getStaffMe(): Promise<StaffMeResponse> {
    return request<StaffMeResponse>('/api/staff/me');
  },

  async setStaffPreference(optIn: boolean): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/api/staff/preferences', {
      method: 'PATCH',
      body: { personal_data_opt_in: optIn },
    });
  },

  /**
   * 导出自己的员工数据（档案 + 考勤 + 排班 + 本人可见的关怀记录）。
   *
   * **没有参数**，这是有意的：服务端只导出会话本人（staff id 由会话解析，
   * 路由不接受 `?staff_id=`）。给这个方法加一个 staffId 参数，就等于向调用方
   * 许诺一个它做不到的能力 —— 而"点了没反应"比"没有这个按钮"更糟。
   *
   * 服务端回的是带 `Content-Disposition: attachment` 的 JSON 附件，这里的
   * `request()` 读的仍然是 JSON 正文 —— 附件头只影响"把 URL 直接输进地址栏"
   * 时的行为。**不为此绕开 request()**：那样会丢掉它统一的 PwaApiError 语义
   * （401/403/409/503 都要能被 UI 显示出来）。
   */
  async exportStaffData(): Promise<StaffDataExport> {
    return request<StaffDataExport>('/api/staff/export');
  },

  /**
   * 打卡。**不传方向** —— 由服务端判定（有未结束记录就签退，否则签到）。
   * 客户端传方向会在两个标签页同时打开时产生错误状态。
   */
  async recordAttendance(): Promise<StaffAttendanceActionResponse> {
    return request<StaffAttendanceActionResponse>('/api/staff/attendance', { method: 'POST' });
  },

  async getAttendanceRecords(from?: string, to?: string): Promise<StaffAttendanceRecord[]> {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const data = await request<{ records: StaffAttendanceRecord[] }>(`/api/staff/attendance${suffix}`);
    return data.records ?? [];
  },

  async getShifts(from?: string, to?: string): Promise<StaffShift[]> {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const data = await request<{ shifts: StaffShift[] }>(`/api/staff/shifts${suffix}`);
    return data.shifts ?? [];
  },

  async getDeliveries(): Promise<StaffDeliveriesResponse> {
    const data = await request<{ pending: Record<string, unknown>[]; mine: Record<string, unknown>[] }>(
      '/api/staff/deliveries',
    );
    return {
      pending: (data.pending ?? []).map(toDeliveryItem),
      mine: (data.mine ?? []).map(toDeliveryItem),
    };
  },

  /** 认领。409 `already_claimed` 意味着被同事抢先 —— UI 要把它当竞争结果，不是故障。 */
  async claimDelivery(deliveryId: string): Promise<{ ok: boolean; rider_status: string }> {
    return request<{ ok: boolean; rider_status: string }>('/api/staff/deliveries/claim', {
      method: 'POST',
      body: { delivery_id: deliveryId },
    });
  },

  async updateDeliveryStatus(
    deliveryId: string,
    status: 'picked_up' | 'delivered',
  ): Promise<{ ok: boolean; rider_status: string }> {
    return request<{ ok: boolean; rider_status: string }>(
      `/api/staff/deliveries/${encodeURIComponent(deliveryId)}/status`,
      { method: 'POST', body: { status } },
    );
  },

  async getReservations(date?: string): Promise<StaffReservationItem[]> {
    const suffix = date ? `?date=${encodeURIComponent(date)}` : '';
    const data = await request<{ reservations: StaffReservationItem[] }>(`/api/staff/reservations${suffix}`);
    return data.reservations ?? [];
  },

  async updateReservationStatus(
    id: string,
    status: 'confirmed' | 'arrived' | 'cancelled',
  ): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(
      `/api/staff/reservations/${encodeURIComponent(id)}/confirm`,
      { method: 'POST', body: { status } },
    );
  },

  async getCareResources(): Promise<CareResource[]> {
    const data = await request<{ resources: CareResource[] }>('/api/staff/care-resources');
    return data.resources ?? [];
  },

  /** 员工端**不做**后厨照片上传：上传者给自己发合格证这件事本身要重新设计。 */
  async getKitchenPhotos(): Promise<KitchenPhoto[]> {
    return [];
  },

  async uploadKitchenPhoto(): Promise<never> {
    throw new PwaApiError(501, 'not_implemented',
      'kitchen photo upload has no backend yet; the previous version let the uploader self-verify, which is not acceptable');
  },
};

// ---------------------------------------------------------------------------
// 7.3 老板端
// ---------------------------------------------------------------------------

export const bossApi = {
  async getTeamMembers(): Promise<TeamMember[]> {
    const data = await request<{ staff: TeamMember[] }>('/api/team');
    return data.staff ?? [];
  },

  async addOrUpdateTeamMember(member: TeamMember): Promise<TeamMember> {
    const isUpdate = Boolean(member.id);
    const data = await request<{ staff: TeamMember }>(
      isUpdate ? `/api/team?id=${encodeURIComponent(member.id)}` : '/api/team',
      { method: isUpdate ? 'PATCH' : 'POST', body: member },
    );
    return data.staff;
  },

  /**
   * 邀请链接。后端在邀请链路修好之前**明确返回 501**，而不是回一个 null ——
   * 原型这里返回过 null，UI 于是渲染出一个空链接，被邀请人永远登不进来。
   */
  async generateInviteUrl(staffId: string, email: string): Promise<{ invite_url: string }> {
    return request<{ invite_url: string }>('/api/team/invite', {
      method: 'POST',
      body: { staff_id: staffId, email },
    });
  },

  async getAttendanceRecords(from?: string, to?: string, staffId?: string): Promise<TeamAttendanceAuditRecord[]> {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    if (staffId) qs.set('staff_id', staffId);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const data = await request<{ records: TeamAttendanceAuditRecord[] }>(`/api/team/attendance${suffix}`);
    return data.records ?? [];
  },

  async retroactiveClock(
    _staffId: string,
    _staffName: string,
    inTime: string,
    outTime: string,
    reason: string,
    attendanceId?: string,
  ): Promise<{ ok: boolean; record?: TeamAttendanceAuditRecord }> {
    // 补卡按**考勤记录 id** 定位。原型按 staff+name 定位，那在一个人多班次时
    // 会改错行 —— 后端只接受 id。缺 id 就报错，不做猜测。
    if (!attendanceId) {
      throw new PwaApiError(400, 'attendance_id_required',
        'a make-up punch must name the attendance record it corrects');
    }
    return request<{ ok: boolean; record?: TeamAttendanceAuditRecord }>(
      `/api/team/attendance?id=${encodeURIComponent(attendanceId)}`,
      { method: 'PATCH', body: { clock_in_at: inTime, clock_out_at: outTime, reason } },
    );
  },

  async getCareSignals(): Promise<CareSignal[]> {
    const data = await request<{ signals: (Omit<CareSignal, 'kind'> & { kind: string })[] }>(
      '/api/team/care/signals',
    );
    return (data.signals ?? []).map((s) => ({ ...s, kind: toUiSignalKind(s.kind) }));
  },

  async refreshCareSignals(): Promise<{ ok: boolean; created: number }> {
    return request<{ ok: boolean; created: number }>('/api/team/care/signals', { method: 'POST', body: {} });
  },

  async handleCareSignal(
    signalId: string,
    decision: 'accept' | 'dismiss',
  ): Promise<{ ok: boolean; status: string; approval_id?: string }> {
    return request<{ ok: boolean; status: string; approval_id?: string }>(
      `/api/team/care/tasks/${encodeURIComponent(signalId)}`,
      { method: 'POST', body: { decision } },
    );
  },

  /**
   * 关怀记录。
   *
   * **不再传 `currentUserId`** —— 原型的默认值 `'usr_owner'` 是一个写死的
   * 演示账号 id，真实会话里不存在。身份由服务端的会话 cookie 决定，
   * 客户端传什么都不看。这也是后端能安全地按"作者或当事人"过滤的前提。
   */
  async getCareNotes(staffId?: string): Promise<CareNote[]> {
    const suffix = staffId ? `?staff_id=${encodeURIComponent(staffId)}` : '';
    const data = await request<{ notes: CareNote[] }>(`/api/team/care/notes${suffix}`);
    return data.notes ?? [];
  },

  async createCareNote(staffId: string, content: string, kind: CareNote['kind'] = 'one_on_one'): Promise<CareNote> {
    const data = await request<{ note: CareNote }>('/api/team/care/notes', {
      method: 'POST',
      body: { staff_id: staffId, content, kind },
    });
    return data.note;
  },

  async getCareResources(): Promise<CareResource[]> {
    const data = await request<{ resources: CareResource[] }>('/api/team/care/resources');
    return data.resources ?? [];
  },

  async getKitchenPhotos(): Promise<KitchenPhoto[]> {
    return [];
  },

  async uploadKitchenPhoto(): Promise<never> {
    throw new PwaApiError(501, 'not_implemented', 'kitchen photo backend does not exist');
  },
};

/**
 * 原型里的演示开关在真实数据层里没有意义 —— 保留导出只为不改 UI 的 import。
 * 任何依赖它来制造 409 的代码，接真后端后都会自然走到真实的 409 路径。
 */
export const simulationState = {
  simulate409ClaimConflict: false,
  simulate409StaffNotLinked: false,
  latencyMs: 0,
};
