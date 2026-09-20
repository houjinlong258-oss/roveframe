/**
 * 邮件账号"能不能真的发出去" —— **单一事实源**。
 *
 * ## 为什么需要它（Phase 16 任务 4）
 *
 * 实测两条判定不一致：
 *   - UI 侧（`api/marketing/send`）：只查 `is_default = true` ⇒ 按钮显示可用；
 *   - worker 侧（`lib/email/outgoing.loadDefaultAccount`）：要求
 *     `status='active'` **且** `smtp_host` 存在 **且** `credentials_encrypted` 存在。
 *
 * 后果：商家看到"账号可用"、点了发送，然后**每一封都失败**。
 * 这与 Phase 15 修掉的 ERPNext 是同一类缺陷 —— UI 声称的能力后端并不具备。
 *
 * 修法是本文件：两条路径调用同一个函数。判定变严或变松都只改这一处。
 */

export interface EmailAccountCandidate {
  id?: string | null;
  email?: string | null;
  display_name?: string | null;
  status?: string | null;
  smtp_host?: string | null;
  smtp_port?: number | null;
  credentials_encrypted?: string | null;
  is_default?: boolean | null;
}

export type EmailAccountBlockReason =
  | 'not_found'
  | 'inactive'
  | 'missing_smtp_host'
  | 'missing_credentials';

export interface EmailAccountEligibility {
  usable: boolean;
  reason: EmailAccountBlockReason | null;
  /** 面向商家的英文说明（前端再按语言本地化；缺 key 时不会显示成空白） */
  message: string;
  /** 规范化后的 SMTP 端口与加密模式（STARTTLS 与 implicit TLS 的分界见下） */
  smtpPort: number | null;
  secure: boolean;
}

/**
 * SMTP 端口的默认值与 TLS 语义。
 *
 * Phase 16 修掉的第三个缺陷：Outlook 预设写 465，而 **Office 365 不接受
 * implicit TLS（465）**，只接受 587 + STARTTLS。
 *
 *   - 465 → implicit TLS（`secure: true`，连上即 TLS）
 *   - 587 / 25 / 其他 → STARTTLS（`secure: false`，明文连上后升级）
 *
 * 判定放在这里而不是调用点：发送与"测试连接"两处必须给出**同一个**结论，
 * 否则又会出现"测试通过但发不出去"。
 */
export const IMPLICIT_TLS_PORT = 465;

export function resolveSmtpTransport(port: number | null | undefined): { port: number; secure: boolean } {
  const resolved = typeof port === 'number' && Number.isFinite(port) && port > 0 ? port : IMPLICIT_TLS_PORT;
  return { port: resolved, secure: resolved === IMPLICIT_TLS_PORT };
}

/** 判定一个账号现在能否真的发出邮件。纯函数，不查库、不联网。 */
export function evaluateEmailAccount(account: EmailAccountCandidate | null | undefined): EmailAccountEligibility {
  if (!account) {
    return {
      usable: false,
      reason: 'not_found',
      message: 'No email account is configured for this business.',
      smtpPort: null,
      secure: false,
    };
  }
  if ((account.status ?? '') !== 'active') {
    return {
      usable: false,
      reason: 'inactive',
      message: `This email account is ${account.status ?? 'unknown'} and cannot send.`,
      smtpPort: null,
      secure: false,
    };
  }
  if (!account.smtp_host) {
    return {
      usable: false,
      reason: 'missing_smtp_host',
      message: 'This email account has no SMTP host; sending is not possible until one is set.',
      smtpPort: null,
      secure: false,
    };
  }
  if (!account.credentials_encrypted) {
    return {
      usable: false,
      reason: 'missing_credentials',
      message: 'This email account has no stored credentials; sending is not possible until it is re-saved.',
      smtpPort: null,
      secure: false,
    };
  }
  const transport = resolveSmtpTransport(account.smtp_port);
  return {
    usable: true,
    reason: null,
    message: 'Ready to send.',
    smtpPort: transport.port,
    secure: transport.secure,
  };
}

/**
 * 按 `is_default` 优先挑一个可用账号。
 * 传入的账号列表应已按业务范围（tenant + business）筛选。
 */
export function pickUsableAccount<T extends EmailAccountCandidate>(
  accounts: readonly T[],
): { account: T; eligibility: EmailAccountEligibility } | { account: null; eligibility: EmailAccountEligibility } {
  const ordered = [...accounts].sort((a, b) => Number(b.is_default ?? false) - Number(a.is_default ?? false));
  for (const account of ordered) {
    const eligibility = evaluateEmailAccount(account);
    if (eligibility.usable) return { account, eligibility };
  }
  return {
    account: null,
    eligibility: evaluateEmailAccount(ordered[0] ?? null),
  };
}

/* ------------------------------------------------------------------ */
/* 已知服务商的 SMTP 预设                                                */
/*                                                                      */
/* 表本身在 `./smtp-presets`（零依赖模块），因为设置页这个**客户端组件**也要用它； */
/* 这里只做转出，避免客户端被迫 import 服务端依赖。                        */
/* ------------------------------------------------------------------ */

export { SMTP_PRESETS, presetForHost, type SmtpPreset } from '@/lib/email/smtp-presets';

/* ------------------------------------------------------------------ */
/* 保存时的真实连接验证                                                  */
/* ------------------------------------------------------------------ */

export interface SmtpVerifyResult {
  ok: boolean;
  error?: string;
  /** 实测使用的端口与 TLS 模式 —— 失败时这是最有用的诊断信息 */
  port: number;
  secure: boolean;
}

/**
 * 真的连一次 SMTP（含 STARTTLS/implicit TLS 与 AUTH）。
 *
 * 调用它的是"保存邮箱账号"这一步。**没有这一步，"已连接"就是没有证据的断言** ——
 * 而商家会据此发送整批营销邮件。
 *
 * 超时 12 秒：比 nodemailer 默认的长，因为跨洋 SMTP 握手 + 认证可能到 5–8 秒；
 * 但必须有上限，否则保存请求会挂住。
 */
export async function verifySmtpConnection(input: {
  host: string;
  port?: number | null;
  user: string;
  pass: string;
  timeoutMs?: number;
}): Promise<SmtpVerifyResult> {
  const transport = resolveSmtpTransport(input.port);
  const timeoutMs = input.timeoutMs ?? 12_000;
  // 动态 import：本模块同时被客户端（设置页）引用，静态引入 nodemailer
  // 会把 node 依赖拖进浏览器包。
  const { default: nodemailer } = await import('nodemailer');
  const mailer = nodemailer.createTransport({
    host: input.host,
    port: transport.port,
    secure: transport.secure,
    auth: { user: input.user, pass: input.pass },
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  });
  try {
    await mailer.verify();
    return { ok: true, port: transport.port, secure: transport.secure };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      port: transport.port,
      secure: transport.secure,
    };
  } finally {
    try {
      mailer.close();
    } catch {
      // close 失败不影响判定结果
    }
  }
}
