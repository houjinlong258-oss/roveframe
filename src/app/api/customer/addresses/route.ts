import { json, jsonError } from '@/lib/api-helpers';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { resolveCustomerSession, type CustomerSessionContext } from '@/lib/customer-auth';

/**
 * GET / POST / PATCH / DELETE /api/customer/addresses —— 顾客收货地址簿。
 *
 * ## 三个动词一律按三条件定位行
 *
 * `account_id` + `tenant_id` + `business_id` 同时写进每条读、写、删。
 * 只按 `account_id` 是不够的：账号 id 一旦跨租户复用（导入、迁移、脏数据），
 * 单条件就会把别的商家的地址读出来/删掉。多写两个条件没有成本（都在索引前缀上）。
 *
 * ## 上限 10 条写在代码里而不是数据库里
 *
 * 上限是**产品规则**，不是数据完整性约束：改上限不应该要求 DDL。
 * 因此超限返回 409（明确可读的错误），而不是撞一个数据库约束换来 500。
 *
 * ## 删除为什么不是 403
 *
 * 删除条件已经包含 account_id，所以"别人的地址"与"不存在的地址"在结果上
 * 完全一致（0 行）—— 都返回 404。返回 403 需要先查一次"它是否存在"，
 * 那等于把接口变成地址 id 的探针。
 *
 * ===========================================================================
 * "一个账号最多一个默认地址"——这个不变量只能由代码保证，因此必须说清楚理由
 * ===========================================================================
 *
 * 库里**没有** `unique (account_id) where is_default` 这样的部分唯一索引
 * （本次约束不允许改 schema），所以并发请求可以写出两个默认地址，除非写入顺序
 * 本身让这件事不可能发生。
 *
 * 顺序是：**先把目标行设成默认，再清掉"除它以外"的默认**。
 * 为什么不是反过来（先清后设）——两个并发的"设为默认"请求在任意交错下的结果：
 *
 *   先清后设（旧写法）：A 清、B 清、A 设、B 设 → 两行都是 true ⇒ **两个默认**
 *   先设后清（现写法）：最后落地的那次"清"以自己为白名单，
 *                       因此它只会把**别人**那一行清掉；若两次清都执行完，
 *                       结果是 0 个默认（用户再点一次即可，界面上"没有默认"
 *                       是可解释的状态，"两个默认"不可解释：结账页会随机挑一个）
 *
 * 也就是说：这个顺序把"可能出现两个默认"降级成"可能一个默认都没有"。
 * PostgREST 没有多语句事务（supabase-js 也不提供），真正的事务需要数据库函数
 * （= 迁移 = 本次不允许的 schema 改动），因此在当前约束下这是能得到的最强保证：
 * **任意交错都不会出现两个默认**。清失败时再补一笔"把刚设的那行退回非默认"
 * 的补偿写，避免把库留在脏状态里（那一笔失败只留日志：已经无路可退）。
 */

/** 每账号地址上限（见文件头说明）。 */
const MAX_ADDRESSES = 10;
const MAX_LABEL = 40;
const MAX_RECIPIENT_NAME = 80;
const MAX_PHONE = 40;
const MAX_ADDRESS_LINE = 240;
const MAX_ADDRESS_NOTE = 240;
/** 与公开下单接口同口径：至少 5 位数字。 */
const MIN_PHONE_DIGITS = 5;

const ADDRESS_COLUMNS = [
  'id', 'label', 'recipient_name', 'recipient_phone',
  'address_line', 'address_note', 'is_default', 'created_at',
].join(', ');

interface AddressBody {
  label?: unknown;
  recipient_name?: unknown;
  recipient_phone?: unknown;
  address_line?: unknown;
  address_note?: unknown;
  is_default?: unknown;
}

function asTrimmedString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export async function GET(request: Request) {
  const session = await resolveCustomerSession(request);
  if (!session) return jsonError('unauthorized', 401);

  const { data, error } = await getSupabaseClient()
    .from('customer_addresses')
    .select(ADDRESS_COLUMNS)
    .eq('account_id', session.accountId)
    .eq('tenant_id', session.tenantId)
    .eq('business_id', session.businessId)
    // 默认地址排最前：结账页要的就是它
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[customer/addresses] list failed:', error.message);
    return jsonError('addresses could not be loaded', 500);
  }
  return json({ addresses: data ?? [] });
}

export async function POST(request: Request) {
  const session = await resolveCustomerSession(request);
  if (!session) return jsonError('unauthorized', 401);

  let body: AddressBody;
  try {
    body = (await request.json()) as AddressBody;
  } catch {
    return jsonError('invalid JSON body', 400);
  }

  const recipientName = asTrimmedString(body.recipient_name, MAX_RECIPIENT_NAME);
  const recipientPhone = asTrimmedString(body.recipient_phone, MAX_PHONE);
  const addressLine = asTrimmedString(body.address_line, MAX_ADDRESS_LINE);
  const label = asTrimmedString(body.label, MAX_LABEL);
  const addressNote = asTrimmedString(body.address_note, MAX_ADDRESS_NOTE);
  // 默认地址只由请求显式指定：不做"第一条自动成为默认"的隐式行为 ——
  // 那种行为会让"顾客从没设过默认，但结账页突然有一个默认地址"变得无法解释。
  const isDefault = body.is_default === true;

  if (!recipientName) return jsonError('recipient_name required', 400);
  if (recipientPhone.replace(/[^0-9]/g, '').length < MIN_PHONE_DIGITS) {
    return jsonError('valid recipient_phone required', 400);
  }
  if (addressLine.length < 4) return jsonError('address_line required', 400);

  const client = getSupabaseClient();
  const { data: existing, error: countError } = await client
    .from('customer_addresses')
    .select('id')
    .eq('account_id', session.accountId)
    .eq('tenant_id', session.tenantId)
    .eq('business_id', session.businessId);
  if (countError) {
    console.error('[customer/addresses] count failed:', countError.message);
    return jsonError('address could not be saved', 500);
  }
  if ((existing ?? []).length >= MAX_ADDRESSES) {
    return jsonError(`address limit reached (max ${MAX_ADDRESSES})`, 409);
  }

  const { data, error } = await client
    .from('customer_addresses')
    .insert({
      account_id: session.accountId,
      tenant_id: session.tenantId,
      business_id: session.businessId,
      label: label || null,
      recipient_name: recipientName,
      recipient_phone: recipientPhone,
      address_line: addressLine,
      address_note: addressNote || null,
      is_default: isDefault,
    })
    .select(ADDRESS_COLUMNS)
    .single();

  if (error || !data) {
    console.error('[customer/addresses] insert failed:', error?.message);
    return jsonError('address could not be saved', 500);
  }

  // select 的列清单是运行时拼的字符串，supabase-js 的返回类型因此收敛不到具体形状，
  // 这里显式收窄（只用到 id），而不是把 any 扩散出去。
  const insertedId = String((data as unknown as { id: string }).id);

  // 设为默认时：**插入之后再清掉别人的默认标记**（顺序理由见文件头）。
  // 这里必须先拿到新行的 id 才能"以自己为白名单"地清理 —— 所以不能像从前那样
  // 先清后插（那条路径在并发下会留下两个默认）。
  if (isDefault) {
    const cleared = await clearOtherDefaults(client, session, insertedId);
    if (!cleared.ok) {
      console.error('[customer/addresses] clear other defaults failed:', cleared.error);
      // 补偿：把刚插入的这条退回非默认。留着两个默认比"保存失败"更糟：
      // 结账页会随机挑一个，而顾客没有任何办法看出哪一个会被用。
      const { error: revertError } = await client
        .from('customer_addresses')
        .update({ is_default: false })
        .eq('id', insertedId)
        .eq('account_id', session.accountId)
        .eq('tenant_id', session.tenantId)
        .eq('business_id', session.businessId)
        .select('id');
      if (revertError) {
        console.error('[customer/addresses] default revert failed:', revertError.message);
      }
      return jsonError('address could not be saved', 500);
    }
  }

  return json({ ok: true, address: data }, 201);
}

export async function DELETE(request: Request) {
  const session = await resolveCustomerSession(request);
  if (!session) return jsonError('unauthorized', 401);

  const id = new URL(request.url).searchParams.get('id')?.trim() ?? '';
  if (!id) return jsonError('id required', 400);

  const client = getSupabaseClient();

  // 先读一次，只为知道"删掉的这一条是不是默认地址"（决定删完要不要补一个默认）。
  // 这一读**不**用来定 404：删除语句本身的结果才是权威（下面那句），
  // 否则"读的时候还在、删的时候已经没了"会变成 500 而不是 404。
  const { data: beforeRaw, error: beforeError } = await client
    .from('customer_addresses')
    .select('id, is_default')
    .eq('id', id)
    .eq('account_id', session.accountId)
    .eq('tenant_id', session.tenantId)
    .eq('business_id', session.businessId)
    .maybeSingle();
  if (beforeError) {
    console.error('[customer/addresses] delete precheck failed:', beforeError.message);
    return jsonError('address could not be deleted', 500);
  }
  const wasDefault = (beforeRaw as { is_default?: boolean } | null)?.is_default === true;

  // select('id') 让"删掉了 0 行"与"删掉了 1 行"可区分。
  // 没有它，supabase-js 对 0 行的删除同样返回 error=null，无法判断是否真的删到。
  const { data, error } = await client
    .from('customer_addresses')
    .delete()
    .eq('id', id)
    .eq('account_id', session.accountId)
    .eq('tenant_id', session.tenantId)
    .eq('business_id', session.businessId)
    .select('id');

  if (error) {
    console.error('[customer/addresses] delete failed:', error.message);
    return jsonError('address could not be deleted', 500);
  }
  if (!data || data.length === 0) return jsonError('address not found', 404);

  // -------------------------------------------------------------------------
  // 删掉的若是默认地址：必须把剩下的一条补成默认
  // -------------------------------------------------------------------------
  // 不补的话账号会停在"有地址、但没有默认地址"的状态 —— 结账页的
  // "从常用地址选取"就挑不出任何一条，而顾客看不出为什么。
  // 选**最近创建**的那一条：它与 GET 列表的排序首位一致（列表按 is_default、
  // created_at 倒序），也就是顾客在界面上第一眼看到的那条。
  //
  // 提升失败时**不把整次删除变成 500**：删除已经真的发生了，回 500 是在撒谎，
  // 而且会诱使客户端重试一次注定 404 的请求。因此用响应体里的
  // `promoted_default_id` / `promote_error` 明说结果（不静默）。
  let promotedDefaultId: string | null = null;
  let promoteError: string | null = null;
  if (wasDefault) {
    const { data: rest, error: restError } = await client
      .from('customer_addresses')
      .select('id')
      .eq('account_id', session.accountId)
      .eq('tenant_id', session.tenantId)
      .eq('business_id', session.businessId)
      .order('created_at', { ascending: false })
      .limit(1);
    if (restError) {
      promoteError = restError.message;
      console.error('[customer/addresses] default promotion lookup failed:', restError.message);
    } else if (rest && rest.length > 0) {
      const promoteId = String((rest[0] as { id: string }).id);
      const { data: promoted, error: promoteWriteError } = await client
        .from('customer_addresses')
        .update({ is_default: true })
        .eq('id', promoteId)
        .eq('account_id', session.accountId)
        .eq('tenant_id', session.tenantId)
        .eq('business_id', session.businessId)
        .select('id');
      if (promoteWriteError) {
        promoteError = promoteWriteError.message;
        console.error('[customer/addresses] default promotion failed:', promoteWriteError.message);
      } else if (promoted && promoted.length > 0) {
        promotedDefaultId = promoteId;
      } else {
        promoteError = 'no row was updated';
        console.error('[customer/addresses] default promotion matched 0 rows');
      }
    }
    // 一条地址都不剩时 promotedDefaultId 保持 null 且 promoteError 保持 null：
    // "账号里已经没有地址了"本身就是完整答案，不是失败。
  }

  return json({
    ok: true,
    id,
    promoted_default_id: promotedDefaultId,
    promote_error: promoteError,
  });
}

// ---------------------------------------------------------------------------
// PATCH /api/customer/addresses?id= —— 编辑地址 / 设为默认
// ---------------------------------------------------------------------------

/**
 * PATCH 语义与 `/api/customer/me` 一致：**字段没出现就是不改**。
 *
 * 用 `in` 判断而不是"取不到就当空"：后者会让一次只想改门牌号的请求顺手把
 * 收餐人清空（recipient_name / recipient_phone / address_line 在库里是 NOT NULL），
 * 于是用户看到的是"保存失败"，而真正的原因是这里替他清了一个字段。
 *
 * `is_default` 只认布尔值：`'true'` / 1 一律 400（宽松解析会让"取消默认"变成
 * "设为默认"）。显式传 `false` 表示"这条不再是我的默认"——此时**不**替别的地址
 * 补默认（那是 DELETE 的语义，见上）：顾客显式取消默认是他自己的选择。
 *
 * 响应里的 `is_default` 是**这次写入的值**，不是回读值：并发下另一个请求可能在
 * 本响应返回前又改了这一行，任何回读都只是另一个同样会过期的快照。
 * 权威列表一律以 GET 为准（前端在成功后就是重新 GET 一次）。
 */
interface AddressPatchBody {
  label?: unknown;
  recipient_name?: unknown;
  recipient_phone?: unknown;
  address_line?: unknown;
  address_note?: unknown;
  is_default?: unknown;
}

export async function PATCH(request: Request) {
  const session = await resolveCustomerSession(request);
  if (!session) return jsonError('unauthorized', 401);

  const id = new URL(request.url).searchParams.get('id')?.trim() ?? '';
  if (!id) return jsonError('id required', 400);

  let body: AddressPatchBody;
  try {
    body = (await request.json()) as AddressPatchBody;
  } catch {
    return jsonError('invalid JSON body', 400);
  }

  const patch: Record<string, unknown> = {};

  if ('label' in body) patch.label = asTrimmedString(body.label, MAX_LABEL) || null;

  if ('recipient_name' in body) {
    const recipientName = asTrimmedString(body.recipient_name, MAX_RECIPIENT_NAME);
    if (!recipientName) return jsonError('recipient_name required', 400);
    patch.recipient_name = recipientName;
  }

  if ('recipient_phone' in body) {
    const recipientPhone = asTrimmedString(body.recipient_phone, MAX_PHONE);
    if (recipientPhone.replace(/[^0-9]/g, '').length < MIN_PHONE_DIGITS) {
      return jsonError('valid recipient_phone required', 400);
    }
    patch.recipient_phone = recipientPhone;
  }

  if ('address_line' in body) {
    const addressLine = asTrimmedString(body.address_line, MAX_ADDRESS_LINE);
    if (addressLine.length < 4) return jsonError('address_line required', 400);
    patch.address_line = addressLine;
  }

  if ('address_note' in body) patch.address_note = asTrimmedString(body.address_note, MAX_ADDRESS_NOTE) || null;

  let wantsDefault = false;
  if ('is_default' in body) {
    if (typeof body.is_default !== 'boolean') {
      return jsonError('is_default must be a boolean', 400);
    }
    wantsDefault = body.is_default;
    patch.is_default = body.is_default;
  }

  if (Object.keys(patch).length === 0) {
    return jsonError('no updatable fields provided', 400);
  }

  const client = getSupabaseClient();

  // 更新条件里带 id + 三条件：别人的地址与不存在的地址结果一致（0 行 → 404），
  // 与 DELETE 同一口径 —— 不给地址 id 的存在性做探针。
  const { data, error } = await client
    .from('customer_addresses')
    .update(patch)
    .eq('id', id)
    .eq('account_id', session.accountId)
    .eq('tenant_id', session.tenantId)
    .eq('business_id', session.businessId)
    .select(ADDRESS_COLUMNS)
    .maybeSingle();

  if (error) {
    console.error('[customer/addresses] update failed:', error.message);
    return jsonError('address could not be updated', 500);
  }
  if (!data) return jsonError('address not found', 404);

  // 设为默认 → 清掉"除它以外"的默认标记（顺序与理由见文件头）
  let clearedOthers = 0;
  if (wantsDefault) {
    const cleared = await clearOtherDefaults(client, session, id);
    if (!cleared.ok) {
      console.error('[customer/addresses] clear other defaults failed:', cleared.error);
      const { error: revertError } = await client
        .from('customer_addresses')
        .update({ is_default: false })
        .eq('id', id)
        .eq('account_id', session.accountId)
        .eq('tenant_id', session.tenantId)
        .eq('business_id', session.businessId)
        .select('id');
      if (revertError) {
        console.error('[customer/addresses] default revert failed:', revertError.message);
      }
      return jsonError('address could not be updated', 500);
    }
    clearedOthers = cleared.cleared;
  }

  return json({ ok: true, address: data, cleared_other_defaults: clearedOthers });
}

/**
 * 清掉本账号"除 keepId 以外"的默认标记。
 *
 * `keepId` 是**刚设置成功的那一行**：白名单必须是它，而不是"当前请求想设的那一条"，
 * 否则并发下两个请求会互相清掉对方刚设好的默认（见文件头）。
 * 返回条数是为了让调用方能判断"到底清了几条"，也让审计/响应说得清结果。
 */
async function clearOtherDefaults(
  client: ReturnType<typeof getSupabaseClient>,
  session: CustomerSessionContext,
  keepId: string,
): Promise<{ ok: true; cleared: number } | { ok: false; error: string }> {
  const { data, error } = await client
    .from('customer_addresses')
    .update({ is_default: false })
    .eq('account_id', session.accountId)
    .eq('tenant_id', session.tenantId)
    .eq('business_id', session.businessId)
    .eq('is_default', true)
    .neq('id', keepId)
    .select('id');
  if (error) return { ok: false, error: error.message };
  return { ok: true, cleared: (data ?? []).length };
}
