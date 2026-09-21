import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getTenantContext, requireBusinessContext } from '@/lib/tenant';
import { protectBusinessMutation } from '@/lib/mutation-guard';
import { resolveAppOrigin } from '@/lib/app-origin';

/**
 * 老板端邀请：给某条员工档案的邮箱发一条**可用的**登录邀请，并把档案与账号关联。
 *
 * ## 为什么不复用 /api/auth/invite
 *
 * `/api/auth/invite` 是既有路由，本任务**不得修改**它。它有三个缺陷，其中第一个是
 * 致命的 —— 因为本路由的返回契约里 `invite_url` 必须**真的能用**：
 *
 *   1. **`app_metadata.tenant_id` 没有写入。**
 *      `inviteUserByEmail(email, { data })` 的 `data` 落到
 *      `auth.users.raw_user_meta_data`（user_metadata），而
 *      `app_metadata` 是另一列。鉴权链读的是后者：
 *        · `src/lib/auth-guard.ts` 的 `verifyJwtLocally()` → `appMeta.tenant_id`
 *        · `src/lib/auth.ts` 的 `resolveUserByToken()` → 同样是 `app_metadata`，
 *          缺失时直接返回 `token has no tenant_id in app_metadata`
 *      实测确认（node_modules/@supabase/auth-js@2.95.3 的
 *      `GoTrueAdminApi.d.ts`）：`inviteUserByEmail` 的选项只有
 *      `{ data?, redirectTo? }`，**没有 `app_metadata`** —— 也就是说该路由
 *      无论怎么调都写不进 tenant 声明。被邀请人于是"邮件能收到、能设密码、
 *      然后每个请求 401"。
 *   2. `redirectTo` 指向不存在的路由（该路由自己已修为 `/<locale>/auth/login`）。
 *   3. 返回 `invite_url: null`（该路由的注释说"调用方用现有邮件通道发送 invite_url"，
 *      返回 null 等于让调用方无法完成这件事）。
 *
 * 本路由不重复这些缺陷：自己走 admin API，拿到邀请链接后**补写
 * `app_metadata`**（`updateUserById` 支持 app_metadata，这是唯一的写入通道），
 * 并且只有在链接与声明**都**就绪时才返回 201。
 *
 * ## 发信方式（Phase 18 决策，用户已确认）
 *
 * 用 `auth.admin.generateLink({ type: 'invite' })` 生成链接，邮件由**商家自己的
 * SMTP** 发出（`sendEmailWithDefaultAccount`）。
 *
 * 不用 `inviteUserByEmail` 的原因：它会让 Supabase Auth 自己发信，而本项目
 * **没有配平台侧 SMTP**，实测该调用返回 **429** —— 那看起来像限流，实际是
 * "平台没有发信能力"。而且邀请邮件本来就该用商家的发件身份。
 *
 * 两种失败分开报告（`email_sent` / `email_error`）：邮件发不出去时链接仍然
 * 可用（商家可手动转发），所以不能因为发信失败就说邀请失败；
 * 也不能因为账号建好了就假装邮件发出去了。
 *
 * ## 失败时的纪律
 *
 * 不返回 `null`、不返回假链接。任何一步失败都返回明确的错误状态：
 *   · 邀请链接拿不到            → 500（上游失败，不是能力缺失）
 *   · app_metadata 补写失败     → 500 + 说明"链接已生成但不可用"
 *   · public.users 占位失败     → 409/500（不静默继续，否则档案会指向错误的账号）
 *
 * 之所以**不**返回 501（"邀请链路必须先行修复"）：经上述核实，本路由可以在
 * 不修改 `/api/auth/invite` 的前提下产出**完整可用**的邀请（链接 + 租户声明 +
 * 账号关联），因此"无法产出可用链接"这一前提不成立。若将来 admin API 的
 * 能力发生变化（例如 app_metadata 不再可由 updateUserById 写入），
 * 本路由会返回 500 并在 message 里说明，而不是降级成返回一个点不开的链接。
 */

const MAX_NAME = 128;
const STAFF_ROLE = 'staff';
/** 邮箱形状的粗略校验。真正的权威是 auth API；这里只拦明显不是邮箱的输入。 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function inviteStaff(request: NextRequest) {
  const context = requireBusinessContext(await getTenantContext(request));

  let body: { staff_id?: unknown; email?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const staffId = typeof body.staff_id === 'string' ? body.staff_id.trim() : '';
  if (!staffId || staffId.length > 36) {
    return NextResponse.json({ error: 'staff_id is required' }, { status: 400 });
  }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || email.length > 255 || !EMAIL.test(email)) {
    return NextResponse.json({ error: 'a valid email is required' }, { status: 400 });
  }

  const client = getSupabaseClient();

  // 员工必须属于**本次会话的**门店。只用 staff_id 查（不带 tenant/business）
  // 会让邀请接口变成"给任意门店的员工发邀请"。
  const { data: staff, error: staffError } = await client
    .from('staff')
    .select('id, name, email, user_id, status')
    .eq('id', staffId)
    .eq('tenant_id', context.tenantId)
    .eq('business_id', context.businessId)
    .maybeSingle();
  if (staffError) return NextResponse.json({ error: staffError.message }, { status: 500 });
  if (!staff) return NextResponse.json({ error: 'staff not found in this store' }, { status: 404 });

  const member = staff as { id: string; name: string; email: string | null; user_id: string | null };
  // 已经关联过账号的档案不允许再邀请：换个邮箱再邀请一次会让"这条档案对应哪个
  // 登录账号"出现两个答案，而关怀记录的可见性规则恰好建立在这个关联上。
  if (member.user_id) {
    return NextResponse.json(
      { error: 'this staff member already has a linked account', code: 'already_linked' },
      { status: 409 },
    );
  }

  const origin = resolveAppOrigin(request);
  // 门店名用于邮件抬头与主题。读失败**不**阻断邀请：拿不到名字就用中性措辞，
  // 而不是让一条本来能用的邀请因为一个展示字段而失败。
  let businessName: string | null = null;
  try {
    const { getSettings } = await import('@/lib/settings');
    const settings = await getSettings(context.tenantId, context.businessId);
    const name = (settings.business as { name?: unknown }).name;
    businessName = typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch (settingsError) {
    console.warn(
      '[team/invite] business name unavailable, using neutral wording:',
      settingsError instanceof Error ? settingsError.message : settingsError,
    );
  }
  // localePrefix 是 'always'：不带 locale 的地址会多一次 307，而邀请邮件里的
  // 跳转对"多一跳"很敏感（有些邮件客户端会把重定向丢掉）。
  const locale = ['en', 'zh', 'es'].includes(request.nextUrl.searchParams.get('locale') ?? '')
    ? request.nextUrl.searchParams.get('locale')!
    : 'en';

  // ---------- 1) 生成邀请链接（**不**让 Supabase 发信） ----------
  //
  // Phase 18 决策（用户已确认）：用 `generateLink` 生成链接，邮件由**商家自己的
  // SMTP** 发出。
  //
  // 为什么不用 `inviteUserByEmail`：它会让 Supabase Auth 自己发那封邀请邮件。
  // 本项目**没有配自定义 SMTP**（平台侧），实测该调用返回 **429**，于是整条邀请
  // 链路不可用 —— 而 429 看起来像"限流"，掩盖了真实原因（平台没有发信能力）。
  // `generateLink` 只生成链接、不发信，正合"邮件走商家自己的通道"这一设计：
  // 邀请邮件本来就该用**商家的**发件身份，而不是平台的。
  const { data: invited, error: inviteError } = await client.auth.admin.generateLink({
    type: 'invite',
    email,
    options: {
      redirectTo: `${origin}/${locale}/auth/login`,
      data: {
        // 仍然写一份到 user_metadata：不是鉴权所需（鉴权读 app_metadata），
        // 而是让被邀请人在首次登录前就能在 Supabase 后台看出"这是给谁、哪个门店的邀请"。
        tenant_id: context.tenantId,
        business_id: context.businessId,
        role: STAFF_ROLE,
        staff_id: member.id,
      },
    },
  });
  if (inviteError || !invited?.user) {
    return NextResponse.json(
      { error: `invite failed: ${inviteError?.message ?? 'unknown'}` },
      { status: 500 },
    );
  }
  const invitedUserId = invited.user.id;
  const inviteUrl = invited.properties?.action_link ?? null;
  if (!inviteUrl) {
    // 没有链接就没有这封邮件。宁可 500，也不要发一封点不开的信。
    return NextResponse.json(
      {
        error: 'invite link generation returned no action_link',
        code: 'no_action_link',
        invited_user_id: invitedUserId,
      },
      { status: 500 },
    );
  }

  // ---------- 2) 补写 app_metadata —— 鉴权链唯一读取的地方 ----------
  //
  // 没有这一步，被邀请人拿到的链接是"能设密码但登录后 401"的死链。
  // 用 admin.updateUserById（SDK 类型里 app_metadata 明确标注"Only a service role can modify"）。
  const { error: claimError } = await client.auth.admin.updateUserById(invitedUserId, {
    app_metadata: {
      tenant_id: context.tenantId,
      business_id: context.businessId,
    },
  });
  if (claimError) {
    // 明确报告"链接已生成但不可用"，而不是把死链当成成功返回。
    return NextResponse.json(
      {
        error: `invite created but the tenant claim could not be written: ${claimError.message}`,
        code: 'claim_write_failed',
        invited_user_id: invitedUserId,
      },
      { status: 500 },
    );
  }

  // ---------- 3) public.users 占位 + 回填 staff.user_id ----------
  //
  // 这一步**不能静默失败**。`resolveUserByToken` 要求 public.users 行存在、
  // 且 tenant_id 与声明一致；档案不回填 user_id，员工端与关怀模块都找不到这个人。
  // 三步里任何一步缺失，"邀请成功"就都是假的。
  const { error: placeholderError } = await client.from('users').insert({
    id: invitedUserId,
    tenant_id: context.tenantId,
    business_id: context.businessId,
    email,
    name: member.name ?? null,
    // 邀请用的是员工档案，角色固定 staff。**不**接受请求体里的 role：
    // 让邀请接口能指定 owner 等于把提权做成一个 POST 参数。
    role: STAFF_ROLE,
  });
  if (placeholderError) {
    return NextResponse.json(
      {
        error: `invite created but the local user row could not be written: ${placeholderError.message}`,
        code: placeholderError.code === '23505' ? 'email_already_registered' : 'placeholder_failed',
        invited_user_id: invitedUserId,
      },
      { status: placeholderError.code === '23505' ? 409 : 500 },
    );
  }

  const { data: linked, error: linkError } = await client
    .from('staff')
    .update({ user_id: invitedUserId })
    .eq('id', member.id)
    .eq('tenant_id', context.tenantId)
    .eq('business_id', context.businessId)
    .select('id, user_id')
    .maybeSingle();
  if (linkError || !linked) {
    return NextResponse.json(
      {
        error: `invite created but the staff profile could not be linked: ${linkError?.message ?? 'staff row disappeared'}`,
        code: 'link_failed',
        invited_user_id: invitedUserId,
      },
      { status: 500 },
    );
  }

  // ---------- 4) 用商家自己的 SMTP 发出邀请邮件 ----------
  //
  // 放在最后一步：前三步（链接 / 租户声明 / 账号关联）都成了才值得发信。
  // 若先发信再发现关联失败，员工会收到一封点进去却进不来的邀请。
  //
  // 失败**不**回滚已建立的账号（那是可用的：链接仍然有效，商家可以把链接
  // 手动转给员工），但必须如实报告"邮件没发出去"，而不是报成功。
  let emailSent = false;
  let emailError: string | null = null;
  try {
    const { sendEmailWithDefaultAccount } = await import('@/lib/email/outgoing');
    await sendEmailWithDefaultAccount(
      context.tenantId,
      context.businessId,
      email,
      businessName ? `You are invited to join ${businessName}` : 'You are invited to join the team',
      [
        `Hello${member.name ? ` ${member.name}` : ''},`,
        '',
        businessName
          ? `You have been invited to join the team workspace at ${businessName}.`
          : 'You have been invited to join the team workspace.',
        'Set your password with the link below, then sign in with this email address.',
        '',
        inviteUrl,
        '',
        'If you were not expecting this invitation, you can ignore this email.',
      ].join('\n'),
    );
    emailSent = true;
  } catch (sendError) {
    emailError = sendError instanceof Error ? sendError.message : String(sendError);
    console.error('[team/invite] invitation email failed:', emailError);
  }

  return NextResponse.json(
    {
      ok: true,
      staff_id: member.id,
      invited_user_id: invitedUserId,
      email,
      role: STAFF_ROLE,
      // 链接本身**一定**可用（不是 null）：前三步成功才走到这里。
      // 邮件发不出去时调用方仍可把它手动转给员工 —— 这也是为什么两者分开报告。
      invite_url: inviteUrl,
      invite_url_source: 'supabase_admin_generate_link',
      email_sent: emailSent,
      // 明确区分"没配邮箱"与"发送失败"：前者要老板去设置页配 SMTP，
      // 后者要查 SMTP 自身。含糊其辞会让两者都停在原地。
      email_error: emailError,
    },
    { status: 201 },
  );
}

export const POST = protectBusinessMutation(
  { permission: 'workforce:manage', action: 'staff.invite', entity: 'staff' },
  inviteStaff,
);
