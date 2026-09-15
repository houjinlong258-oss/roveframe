import crypto from "crypto";

let warnedServiceKeyFallback = false;

/**
 * AES-256-GCM 加密，用于 API Key / 邮箱凭据等敏感配置落库。
 * 密钥来源：ENCRYPTION_SECRET 优先；缺省时派生自 Supabase service_role_key。
 *
 * ⚠️ 回落是**已知有害**但暂时保留的兼容路径：
 * service_role_key 是数据库超级凭据。用它当加密密钥意味着
 * ① 两套密钥的轮换周期被迫绑定；② 一旦轮换 service_role_key，
 * 所有已落库凭据**永久无法解密**，且直到下一次读取才会暴露。
 * 因此这里不再静默：首次回落必须打印显著告警。
 * 彻底移除回落需要先在部署环境提供 ENCRYPTION_SECRET（见技术债登记 P1-15）。
 */
function getKey(): Buffer {
  const explicit = process.env.ENCRYPTION_SECRET;
  const fallback = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY;
  const configured = explicit || fallback;
  // A predictable fallback would make every tenant credential recoverable from
  // the source bundle. Fail closed in production; keep the local fallback only
  // for explicitly non-production development and tests.
  if (!configured && (process.env.COZE_PROJECT_ENV === 'PROD' || process.env.NODE_ENV === 'production')) {
    throw new Error('ENCRYPTION_SECRET is required in production');
  }
  if (!explicit && fallback && !warnedServiceKeyFallback) {
    warnedServiceKeyFallback = true;
    console.warn(
      '[crypto] ENCRYPTION_SECRET is not set — deriving the credential-encryption key from ' +
      'COZE_SUPABASE_SERVICE_ROLE_KEY. Rotating that Supabase key will permanently invalidate ' +
      'every stored credential. Set ENCRYPTION_SECRET explicitly.',
    );
  }
  const secret = configured || 'roveframe-dev-secret';
  return crypto.createHash("sha256").update(secret).digest();
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
}

export function decrypt(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(".");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

export function mask(secret: string | null | undefined): string {
  if (!secret) return "";
  if (secret.length <= 8) return "****";
  return `${secret.slice(0, 4)}****${secret.slice(-4)}`;
}
