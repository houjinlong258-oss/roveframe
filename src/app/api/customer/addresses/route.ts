import { json, jsonError } from '@/lib/api-helpers';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { resolveCustomerSession } from '@/lib/customer-auth';

/**
 * GET / POST / DELETE /api/customer/addresses —— 顾客收货地址簿。
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

  // 默认地址只允许一条：先把旧的清掉，再插入新的。
  // 顺序不能反过来 —— 先插后清会把刚插入的那条一起清掉。
  if (isDefault) {
    const { error: clearError } = await client
      .from('customer_addresses')
      .update({ is_default: false })
      .eq('account_id', session.accountId)
      .eq('tenant_id', session.tenantId)
      .eq('business_id', session.businessId)
      .eq('is_default', true);
    if (clearError) {
      console.error('[customer/addresses] clear default failed:', clearError.message);
      return jsonError('address could not be saved', 500);
    }
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
  return json({ ok: true, address: data }, 201);
}

export async function DELETE(request: Request) {
  const session = await resolveCustomerSession(request);
  if (!session) return jsonError('unauthorized', 401);

  const id = new URL(request.url).searchParams.get('id')?.trim() ?? '';
  if (!id) return jsonError('id required', 400);

  // select('id') 让"删掉了 0 行"与"删掉了 1 行"可区分。
  // 没有它，supabase-js 对 0 行的删除同样返回 error=null，无法判断是否真的删到。
  const { data, error } = await getSupabaseClient()
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

  return json({ ok: true, id });
}
