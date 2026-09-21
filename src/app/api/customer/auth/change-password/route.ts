import { json, jsonError } from '@/lib/api-helpers';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import {
  hashPassword,
  resolveCustomerSession,
  revokeCustomerSessions,
  verifyPassword,
  type CustomerSessionContext,
  type PasswordDigest,
} from '@/lib/customer-auth';
import { checkFixedWindow, rateLimitResponse } from '@/lib/rate-limit';

/**
 * POST /api/customer/auth/change-password —— 顾客自己改密码。
 *
 * ## 为什么要先验当前密码
 *
 * 只凭会话就允许改密码，等于**任何一次会话劫持都能永久接管账号**：攻击者改掉
 * 密码后，真正的顾客连登录都做不到，而顾客侧没有"忘记密码"通道可以自救。
 * 与商家侧 `/api/auth/change-password`（src/app/api/auth/change-password/route.ts）
 * 同一口径：先证明操作者知道旧密码，再写新密码。
 *
 * ## 当前密码错误为什么是 401 且**响应体与登录失败逐字相同**
 *
 * 这里刻意不引入"当前密码不正确"这类可读措辞：它会把本接口变成
 * "这个会话的账号密码是不是 X" 的判定器 —— 会话被短暂拿到的人可以离线爆破旧密码，
 * 而 401 的措辞差异就是爆破的反馈信号。因此复用登录路由的那一个对象字面量
 * （`INVALID_CREDENTIALS`，见 src/app/api/customer/auth/login/route.ts:55）：
 * 两个接口的失败响应必须无法区分，所以两处写的必须是同一个形状。
 * 本模块不 import 那个常量，是因为登录路由不导出它 —— 改动其中一处必须顺手改另一处，
 * 这条注释就是那个义务的落点（tests/customer-account.test.ts 断言的正是这一点）。
 *
 * ## 撤销**除自己以外**的全部会话（本接口的重点）
 *
 * 改密码的目的就是"把别人挡在外面"。只改 password_hash 而不撤销会话，
 * 已经在别处登录的会话仍然有效 30 天（cookie 里的 token 与口令无关），
 * 这次改密码就只是一个装饰。因此写新口令的同时撤销该账号所有其它会话，
 * 只保留调用方这一个（否则用户改完密码就被自己登出）。
 *
 * 顺序是**先撤销、后写口令**：反过来（先写口令、撤销失败）会留下
 * "口令已换、别人的会话仍然有效"这个正好要避免的状态；而先撤销失败时口令没动，
 * 用户拿旧密码重试即可 —— 两个失败方向里，这个方向是可恢复的那个。
 *
 * ## 新口令用新 salt
 *
 * `hashPassword` 每次调用都取新随机 salt。沿用旧 salt 会让"同一个口令两次改"
 * 得到同一个摘要，口令库里出现相同摘要就等于泄露了"这个人没换过密码"。
 *
 * ## 测试缝：`PasswordChangeDeps`
 *
 * 处理函数把三件副作用（读凭据 / 写摘要 / 撤销会话）做成可注入参数，
 * 默认实现全部打真实库。这与 `src/lib/audit.ts` 的 `_setAuditSinkForTest`、
 * `src/app/api/staff/preferences/route.ts` 的 `StaffSettingsRowLoader` 是同一形态：
 * 没有这个缝，"当前密码错误必须是 401 且不泄漏"这条断言就只能靠正则读源码，
 * 而正则读不出"这个分支到底返回了什么"。**生产调用方一律不传第三个参数。**
 */

/** 与注册、登录页保持一致。 */
const MIN_PASSWORD_LENGTH = 8;
/** 上限只为挡住"拿 1MB 当密码"：scrypt 成本随输入线性增长（与注册同口径）。 */
const MAX_PASSWORD_LENGTH = 200;

/** 每个账号 5 次/15min + 指数退避：这是口令爆破面，必须限流（与商家侧 P0-1 同口径）。 */
const PASSWORD_BACKOFF = { baseMs: 15 * 60_000, maxMs: 60 * 60_000 };
const ACCOUNT_WINDOW = { limit: 5, windowMs: 15 * 60_000, backoff: PASSWORD_BACKOFF };

/**
 * 与登录路由**逐字相同**的失败体（见文件头）。单一事实来源在本文件内，
 * 因此本文件两处失败分支共用同一个常量，不会各写一份。
 */
const INVALID_CREDENTIALS = { error: 'invalid credentials' } as const;

/** 库里与口令有关的两列。**不导出**——只有下面的默认实现需要它。 */
interface CustomerCredentialRow {
  password_hash: string;
  password_salt: string;
}

export interface PasswordChangeDeps {
  /** 读当前摘要；账号行不存在返回 null；**库读失败必须抛错**（"不知道"≠"没有"）。 */
  loadCredentials(session: CustomerSessionContext): Promise<CustomerCredentialRow | null>;
  /** 写新摘要；0 行被更新返回 false；库写失败必须抛错。 */
  savePassword(session: CustomerSessionContext, digest: PasswordDigest): Promise<boolean>;
  /** 撤销除调用方以外的会话；库写失败必须抛错。 */
  revokeOtherSessions(request: Request, session: CustomerSessionContext): Promise<number>;
}

const DEFAULT_DEPS: PasswordChangeDeps = {
  async loadCredentials(session) {
    const { data, error } = await getSupabaseClient()
      .from('customer_accounts')
      .select('password_hash, password_salt')
      // 三条件与 /api/customer/me 同一口径：会话已锁租户，但查询里再写一遍是
      // 纵深防御 —— 账号行与会话行万一不一致（账号被挪到别的商家），这里必须查不到。
      .eq('id', session.accountId)
      .eq('tenant_id', session.tenantId)
      .eq('business_id', session.businessId)
      .maybeSingle();
    // 读失败抛错而不是回 null：null 的含义是"账号行不存在"（合法状态），
    // 把两者混同会让一次数据库抖动表现成"你的账号没了"。
    if (error) throw new Error(`customer credential read failed: ${error.message}`);
    return (data as CustomerCredentialRow | null) ?? null;
  },

  async savePassword(session, digest) {
    const { data, error } = await getSupabaseClient()
      .from('customer_accounts')
      .update({ password_hash: digest.hash, password_salt: digest.salt })
      .eq('id', session.accountId)
      .eq('tenant_id', session.tenantId)
      .eq('business_id', session.businessId)
      // select('id')：0 行的 update 在 supabase-js 里同样是 error=null，
      // 没有它就分不清"改了 1 行"与"什么都没改"，后者会让用户以为密码换了。
      .select('id');
    if (error) throw new Error(`customer password write failed: ${error.message}`);
    return (data ?? []).length > 0;
  },

  async revokeOtherSessions(request, session) {
    const result = await revokeCustomerSessions(request, session.accountId, { keepCurrent: true });
    if (!result.ok) throw new Error(`customer session revocation failed: ${result.error}`);
    return result.revoked;
  },
};

interface ChangePasswordBody {
  current_password?: unknown;
  new_password?: unknown;
}

/**
 * 处理函数本体。**导出是为了能被测试直接调用**（见文件头"测试缝"）：
 * 第三个参数只在测试里传，POST 一律用默认实现。
 */
export async function changeCustomerPassword(
  request: Request,
  session: CustomerSessionContext,
  deps: PasswordChangeDeps = DEFAULT_DEPS,
): Promise<Response> {
  let body: ChangePasswordBody;
  try {
    body = (await request.json()) as ChangePasswordBody;
  } catch {
    return jsonError('invalid JSON body', 400);
  }

  const currentPassword = typeof body.current_password === 'string' ? body.current_password : '';
  const newPassword = typeof body.new_password === 'string' ? body.new_password : '';
  if (!currentPassword) return jsonError('current_password is required', 400);
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return jsonError(`new_password must be at least ${MIN_PASSWORD_LENGTH} characters`, 400);
  }
  if (newPassword.length > MAX_PASSWORD_LENGTH) {
    return jsonError(`new_password must be at most ${MAX_PASSWORD_LENGTH} characters`, 400);
  }

  // 限流放在读库之前：它是免费的，且能在碰口令库之前挡掉爆破流量。
  // 按**账号**计数而不是按 IP（与商家侧 P0-1 同一条理由）：共用出口 IP 的
  // 门店/家庭会互相误伤，而真正的攻击者打的是某一个账号。
  const limit = checkFixedWindow(
    `customer:change-password:account:${session.accountId}`,
    ACCOUNT_WINDOW,
  );
  if (!limit.ok) return rateLimitResponse(limit);

  let row: CustomerCredentialRow | null;
  try {
    row = await deps.loadCredentials(session);
  } catch (error) {
    console.error(
      '[customer/change-password] credential read failed:',
      error instanceof Error ? error.message : error,
    );
    return jsonError('password change could not be completed', 500);
  }
  // 会话有效但账号行不在：与"旧密码错"共用同一个 401 体，不泄漏是哪一种。
  if (!row) return json(INVALID_CREDENTIALS, 401);

  if (!verifyPassword(currentPassword, row.password_salt, row.password_hash)) {
    return json(INVALID_CREDENTIALS, 401);
  }

  // 1) 先撤销其它会话（顺序理由见文件头）
  let revoked = 0;
  try {
    revoked = await deps.revokeOtherSessions(request, session);
  } catch (error) {
    console.error(
      '[customer/change-password] session revocation failed:',
      error instanceof Error ? error.message : error,
    );
    // 什么都没改成 → 可以安全地让用户重试
    return jsonError('password change could not be completed', 500);
  }

  // 2) 再写新口令（新 salt：hashPassword 内部取随机 salt）
  const digest = hashPassword(newPassword);
  let saved: boolean;
  try {
    saved = await deps.savePassword(session, digest);
  } catch (error) {
    console.error(
      '[customer/change-password] password write failed:',
      error instanceof Error ? error.message : error,
    );
    return jsonError('password change could not be completed', 500);
  }
  if (!saved) {
    console.error('[customer/change-password] password write matched 0 rows');
    return jsonError('password change could not be completed', 500);
  }

  // 不回显任何口令字段，也不回显摘要。
  // revoked_sessions 是给前端的一句"其它设备已被登出"的提示用的，不含任何身份信息。
  return json({ ok: true, revoked_sessions: revoked });
}

export async function POST(request: Request): Promise<Response> {
  const session = await resolveCustomerSession(request);
  if (!session) return jsonError('unauthorized', 401);
  return changeCustomerPassword(request, session);
}
