/**
 * SMTP 服务商预设 —— **纯数据、零依赖**，因此客户端与服务端都能引用。
 *
 * 为什么单独成文件：`@/lib/email/eligibility` 里既有预设又有 `nodemailer`
 * 相关的服务端语义；客户端（设置页）只需要这张表。把它放在无依赖的模块里，
 * 两边引用同一份事实，端口不会再次各写一套。
 *
 * ## 端口不是偏好，是服务商的要求
 *
 *   - `465` → **implicit TLS**：连上立即 TLS（`secure: true`）
 *   - `587` → **STARTTLS**：先明文连接再升级（`secure: false`）
 *
 * Phase 16 修掉的缺陷：设置页把默认端口写成 `465`，而 Office 365
 * **不接受 465**，只接受 587 + STARTTLS ⇒ 用 Outlook 的商家永远发不出邮件，
 * 而 UI 上没有任何提示。
 */

export interface SmtpPreset {
  host: string;
  port: number;
  hint: string;
}

export const SMTP_PRESETS: Readonly<Record<string, SmtpPreset>> = {
  outlook: { host: 'smtp.office365.com', port: 587, hint: 'Office 365 requires STARTTLS on 587 (not 465).' },
  gmail: { host: 'smtp.gmail.com', port: 587, hint: 'Gmail requires STARTTLS on 587 and an app password.' },
  icloud: { host: 'smtp.mail.me.com', port: 587, hint: 'iCloud uses STARTTLS on 587.' },
  zoho: { host: 'smtp.zoho.com', port: 465, hint: 'Zoho accepts implicit TLS on 465.' },
};

/** 根据 host 猜测服务商（用于把端口纠正到该服务商要求的那个） */
export function presetForHost(host: string | null | undefined): SmtpPreset | null {
  if (!host) return null;
  const normalized = host.trim().toLowerCase();
  for (const preset of Object.values(SMTP_PRESETS)) {
    if (normalized === preset.host) return preset;
  }
  if (normalized.endsWith('office365.com') || normalized.endsWith('outlook.com')) return SMTP_PRESETS.outlook;
  if (normalized.endsWith('gmail.com') || normalized.endsWith('googlemail.com')) return SMTP_PRESETS.gmail;
  return null;
}
