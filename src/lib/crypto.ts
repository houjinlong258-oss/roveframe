import crypto from "crypto";

/**
 * AES-256-GCM 加密，用于 API Key / 邮箱凭据等敏感配置落库。
 * 密钥来源：ENCRYPTION_SECRET，缺省时派生自 Supabase service_role_key（同一部署内自洽）。
 */
function getKey(): Buffer {
  const configured = process.env.ENCRYPTION_SECRET || process.env.COZE_SUPABASE_SERVICE_ROLE_KEY;
  // A predictable fallback would make every tenant credential recoverable from
  // the source bundle. Fail closed in production; keep the local fallback only
  // for explicitly non-production development and tests.
  if (!configured && (process.env.COZE_PROJECT_ENV === 'PROD' || process.env.NODE_ENV === 'production')) {
    throw new Error('ENCRYPTION_SECRET is required in production');
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
