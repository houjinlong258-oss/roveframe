/**
 * POST /api/auth/signup
 *
 * Body: { email, password, business_name, industry, language?, currency? }
 * 流程: auth.admin.createUser → 建 tenant → 建 business → 建 public.users → 返 access_token
 */
import { json, jsonError } from '@/lib/api-helpers';
import {
  createAuthUserWithTenant,
  createBusinessRow,
  createPublicUserRow,
  createTrialSubscriptionRow,
  isSecureRequest,
  sessionCookieHeader,
  createTenantRow,
  signInAndGetToken,
} from '@/lib/auth';
import { updateSettings } from '@/lib/settings';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { PLAN_IDS, SIGNUP_TRIAL_PLAN, trialPeriodEnd } from '@/lib/subscription-plans';
import {
  checkFixedWindow,
  getClientIp,
  noteFailure,
  noteSuccess,
  rateLimitResponse,
} from '@/lib/rate-limit';

interface SignupBody {
  email: string;
  password: string;
  business_name: string;
  industry: string;
  language?: string;
  currency?: string;
  name?: string;
}

const AUTH_BACKOFF = { baseMs: 15 * 60_000, maxMs: 60 * 60_000 };

/**
 * 注册失败的补偿回滚。
 *
 * ## 为什么必须有它
 *
 * 注册分七步：建租户 → 建业务 → 建试用订阅 → 建 auth 用户 → 建 public.users
 * → 建 settings → 登录取 token。**这七步不是事务**，任何一步失败都会把前面几步的
 * 产物留在库里。
 *
 * 原注释把残余判断为"与建 business 失败的后果同级"，但实测（2026-09-19）后果更重：
 * 用已注册邮箱去注册时，库里斯增了一个有业务、有订阅、却没有任何登录凭据的租户
 * （`424323Hou`：businesses=1, users=0, settings=0）。它在租户列表里可见，
 * 而用户看到的是 500 —— **不知道该怎么办，于是重试，重试触发限流，
 * 最后连登录都被锁住**。用户的结论是"连不上数据库"，与真实原因完全无关。
 *
 * ## 为什么不是"把 auth 用户提到最前面"
 *
 * 那样失败会留下一个"邮箱已被占用、却没有工作区"的 auth 用户 ——
 * 用户**永远无法再用这个邮箱注册**，比孤儿租户更难挽回。
 * 保持现有顺序 + 失败回滚，才对得起"要么完整、要么什么都没有"。
 *
 * ## 回滚失败怎么办
 *
 * 逐条执行、单条失败只记日志、继续下一条：回滚出错不能掩盖**原始**错误，
 * 那才是用户需要看到的。但日志必须留 —— 静默吞掉会让残余无人知晓。
 */
/**
 * 把 supabase-js 的 error 取值成可读文本。
 *
 * 它的 error 类型在 TS 里是联合（PostgrestError | AuthError | null | {}），
 * 直接读 `.message` 会被判成"`{}` 上不存在该属性"。这里统一收窄，
 * 顺带保证未知形态也能打印出**某些**东西 —— 回滚日志里出现 `undefined`
 * 等于没有日志。
 */
function errText(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

async function rollbackSignup(created: {
  tenantId?: string;
  businessId?: string;
  userId?: string;
}): Promise<void> {
  const client = getSupabaseClient();

  // 先删引用方，再删被引用方。agent_tasks / agent_task_runs 不在本路由里创建，
  // 但它们引用 business，不清掉会让删 business 直接撞外键（实测过）。
  const steps: { label: string; run: () => PromiseLike<{ error: unknown }> }[] = [];
  if (created.tenantId) {
    const tenantId = created.tenantId;
    const businessId = created.businessId;
    /**
     * 删除条件同时带 tenant_id 与 business_id（凡是有该列的表）。
     *
     * 只按 tenant_id 删会被 P0-5「业务隔离」守卫拦下 —— 那次拦截是对的：
     * 回滚与其它写路径一样必须按业务隔离，否则将来一个租户下出现多个 business 时，
     * 回滚会把别的业务一起删掉。
     *
     * `businesses` 按 id + tenant_id 定位，`tenants` 按 id 定位，都不需要 business_id。
     * business_id 缺失时（第 2 步就失败）只按 tenant_id 删 —— 那时租户下确实
     * 只有这一处产物。
     */
    const scoped = (table: string) => {
      const base = client.from(table).delete().eq('tenant_id', tenantId);
      return businessId ? base.eq('business_id', businessId) : base;
    };
    steps.push(
      { label: 'agent_task_runs', run: () => scoped('agent_task_runs') },
      { label: 'agent_tasks', run: () => scoped('agent_tasks') },
      { label: 'settings', run: () => scoped('settings') },
      { label: 'tenant_subscriptions', run: () => client.from('tenant_subscriptions').delete().eq('tenant_id', tenantId) },
      { label: 'users', run: () => scoped('users') },
      { label: 'businesses', run: () => (businessId
        ? client.from('businesses').delete().eq('id', businessId).eq('tenant_id', tenantId)
        : client.from('businesses').delete().eq('tenant_id', tenantId)) },
      { label: 'tenants', run: () => client.from('tenants').delete().eq('id', tenantId) },
    );
  }

  for (const step of steps) {
    try {
      const { error } = await step.run();
      if (error) console.error(`[signup] rollback "${step.label}" failed:`, errText(error));
    } catch (error) {
      console.error(`[signup] rollback "${step.label}" threw:`, error instanceof Error ? error.message : error);
    }
  }

  // auth 用户最后删：它不受租户外键约束，且删除失败最需要被看见。
  if (created.userId) {
    try {
      const { error } = await client.auth.admin.deleteUser(created.userId);
      if (error) console.error('[signup] rollback "auth user" failed:', errText(error));
    } catch (error) {
      console.error('[signup] rollback "auth user" threw:', error instanceof Error ? error.message : error);
    }
  }
}

/**
 * GoTrue 对重复邮箱的报错形态不止一种（HTTP 422 `email_exists` /
 * "A user with this email address has already been registered" / 不同版本的措辞）。
 * 这里做**窄匹配**：只认明确的"已存在"信号；
 * 认不出来时按 500 处理 —— 宁可说"服务端出错"，也不能把别的原因误报成"邮箱已注册"
 * 而把用户引向"去登录"这个错误的下一步。
 */
function isEmailAlreadyRegistered(message: string): boolean {
  return /already\s+(been\s+)?(registered|exists)|email_exists|user already registered/i.test(message);
}

export async function POST(request: Request) {
  let body: SignupBody;
  try {
    body = (await request.json()) as SignupBody;
  } catch {
    return jsonError('invalid JSON body', 400);
  }

  const { email, password, business_name, industry } = body;
  if (!email || !password || !business_name || !industry) {
    return jsonError('email / password / business_name / industry required', 400);
  }
  if (password.length < 8) {
    return jsonError('password must be at least 8 characters', 400);
  }

  // P0-1：注册限流 —— 每账号 5 次/15min + 指数退避；每 IP 10 次/15min。
  const emailKey = `auth:signup:email:${email.trim().toLowerCase()}`;
  const ipKey = `auth:signup:ip:${getClientIp(request)}`;
  const accountLimit = checkFixedWindow(emailKey, {
    limit: 5,
    windowMs: 15 * 60_000,
    backoff: AUTH_BACKOFF,
  });
  if (!accountLimit.ok) return rateLimitResponse(accountLimit);
  const ipLimit = checkFixedWindow(ipKey, {
    limit: 10,
    windowMs: 15 * 60_000,
    backoff: AUTH_BACKOFF,
  });
  if (!ipLimit.ok) return rateLimitResponse(ipLimit);

  /**
   * 已创建产物的追踪器。每一步成功后写入，任何一步失败时交给 `rollbackSignup` 撤销。
   * 用它而不是在回滚处拼参数：拼参数的地方会随步骤增加而漏，追踪器不会。
   */
  const created: { tenantId?: string; businessId?: string; userId?: string } = {};

  // 1) 建 tenant
  const t = await createTenantRow({ name: business_name });
  if (!t.ok) {
    noteFailure(emailKey, AUTH_BACKOFF);
    return jsonError(`create tenant failed: ${t.error}`, 500);
  }
  created.tenantId = t.data.tenantId;

  // 2) 建 business
  const b = await createBusinessRow({
    tenantId: t.data.tenantId,
    name: business_name,
    industry,
    language: body.language,
    currency: body.currency,
  });
  if (!b.ok) {
    await rollbackSignup(created);
    return jsonError(`create business failed: ${b.error}`, 500);
  }
  created.businessId = b.data.businessId;

  // 3) 建试用订阅（Phase 16 任务 2）
  //
  // 必须在建 auth 用户**之前**：权益门禁是 fail-closed 的，没有订阅行的租户
  // 写操作被拒。如果先把凭据发出去、再发现订阅建不上，用户就拿到一个
  // "能登录但什么都做不了"的账号。
  //
  // 订正（Phase 18）：原注释接着写"失败 ⇒ 整体 500，用户重试即可，残余只是一个
  // 没有登录凭据的 tenant+business" —— 那低估了后果。实测那次残余在租户列表里
  // 可见，而 500 不告诉用户该做什么，于是重试、触发限流、最后连登录都被锁。
  // 现在失败即回滚，不留残余。
  const trialEndsAt = trialPeriodEnd();
  const sub = await createTrialSubscriptionRow({
    tenantId: t.data.tenantId,
    planId: PLAN_IDS[SIGNUP_TRIAL_PLAN],
    trialEndsAt,
  });
  if (!sub.ok) {
    await rollbackSignup(created);
    return jsonError(`create subscription failed: ${sub.error}`, 500);
  }

  // 4) 建 auth user + 注入 tenant claim
  const a = await createAuthUserWithTenant({
    email,
    password,
    tenantId: t.data.tenantId,
    businessId: b.data.businessId,
    name: body.name,
  });
  if (!a.ok) {
    /**
     * 邮箱已注册：这是**最常见的一种失败**，而且用户能自己解决 —— 去登录。
     *
     * 此前这里一律返回 500 `create auth user failed: ...`，用户既不知道原因，
     * 也不知道该怎么办；库里斯增一个孤儿租户。实测就是这么发生的。
     * 现在：回滚干净 + 409 + 一句可执行的提示。
     *
     * 用 409 而不是 400：邮箱占用是**状态冲突**，不是请求格式错误。
     */
    const already = isEmailAlreadyRegistered(a.error ?? '');
    // 先回滚再返回：顺序反了会在回滚失败时连响应都发不出去。
    await rollbackSignup(created);
    if (already) {
      return jsonError('This email is already registered. Sign in instead, or reset the password.', 409);
    }
    noteFailure(emailKey, AUTH_BACKOFF);
    return jsonError(`create auth user failed: ${a.error}`, 500);
  }
  created.userId = a.data.userId;

  // 5) 建 public.users 关联行
  const u = await createPublicUserRow({
    id: a.data.userId,
    tenantId: t.data.tenantId,
    businessId: b.data.businessId,
    email,
    name: body.name,
    role: 'owner',
  });
  if (!u.ok) {
    // auth 用户已建成但关联行失败 ⇒ 账号能登录却进不了任何工作区。
    // 不保留这种半成品：回滚会把 auth 用户一并删掉，邮箱重新可用。
    await rollbackSignup(created);
    return jsonError(`create public.users failed: ${u.error}`, 500);
  }

  // 6) 建 settings 行（Phase 16 任务 3）
  //
  // 实测缺口：注册不建 settings 行 → `/api/store/menu` 读 `settings.business.name`
  // 拿到 undefined → 门店菜单显示字面量 "Store"；货币同理落到 'USD' 默认值，
  // 而商家在注册时选的货币被写入 `businesses.currency`，**没有任何代码读它**。
  //
  // 选择"注册时建行"而不是"读的时候合成一行"：合成行会让 `settings.business`
  // 在商家第一次保存设置前后语义不同（一个是派生值、一个是真值），
  // 而 `/api/settings` 的写入路径又依赖 `settings.id` 是否存在来决定 insert/update。
  // 建行只有一个事实来源。
  //
  // 失败即整体失败：settings 缺失的后果是"菜单上店名是 Store"，属用户可见错误。
  try {
    await updateSettings(t.data.tenantId, b.data.businessId, {
      business: { name: business_name, industry },
      locale: {
        language: body.language ?? 'en',
        currency: body.currency ?? 'USD',
      },
    });
  } catch (error) {
    await rollbackSignup(created);
    return jsonError(
      `create settings failed: ${error instanceof Error ? error.message : String(error)}`,
      500,
    );
  }

  // 7) 登录取 access_token
  const s = await signInAndGetToken({ email, password });
  if (!s.ok) {
    // 凭据建成了却登不进去，说明这个账号对用户不可用。回滚比留一个
    // "注册成功但登不上"的账号更好 —— 后者会让用户以为密码错了。
    await rollbackSignup(created);
    noteFailure(emailKey, AUTH_BACKOFF);
    return jsonError(`sign in failed: ${s.error}`, 500);
  }
  noteSuccess(emailKey);

  const response = json(
    {
      user_id: s.data.userId,
      tenant_id: t.data.tenantId,
      business_id: b.data.businessId,
      role: 'owner',
      subscription: { status: 'trialing', plan: SIGNUP_TRIAL_PLAN, current_period_end: trialEndsAt },
    },
    201,
  );
  response.headers.set('Set-Cookie', sessionCookieHeader(s.data.accessToken, isSecureRequest(request)));
  return response;
}
