import crypto from "crypto";

/**
 * AES-256-GCM 加密，用于 API Key / 邮箱凭据等敏感配置落库。
 *
 * ## 密钥来源（Phase 12 / R-03 修复后）
 *
 * | 环境 | ENCRYPTION_SECRET | 行为 |
 * |---|---|---|
 * | 生产 | 已设置 | 使用它 |
 * | 生产 | 未设置 | **抛错，拒绝启动**（无论 service_role_key 是否存在） |
 * | 非生产 | 已设置 | 使用它 |
 * | 非生产 | 未设置 | 使用固定的开发默认值，并打印告警 |
 *
 * ## 为什么删掉了 service_role_key 回落
 *
 * 旧实现在 `ENCRYPTION_SECRET` 缺失时把 `COZE_SUPABASE_SERVICE_ROLE_KEY` 当作
 * 加密密钥。这有两个后果：
 *
 * 1. **生产护栏实际上从未生效。** 旧代码只在「两个变量都没有」时抛错，
 *    而生产部署里 service_role_key 必然存在 —— 也就是说回落是**必然发生**的，
 *    不是边缘情况。审计把它列为「已知有害但保留」，但它在生产里不是"可能"，
 *    而是"一定"。
 * 2. **轮换即毁数据。** 数据库超级凭据一旦轮换，所有已落库凭据永久无法解密，
 *    且直到下一次读取才会暴露。
 *
 * 现在两套密钥完全解耦：数据库凭据与凭据加密密钥各自独立轮换。
 *
 * ## 迁移
 *
 * 已经用旧的派生密钥加密过的数据不会失效。设置：
 *
 * ```
 * ENCRYPTION_SECRET=<新的专用密钥>
 * ENCRYPTION_SECRET_PREVIOUS=<原 COZE_SUPABASE_SERVICE_ROLE_KEY 的值>
 * ```
 *
 * `ENCRYPTION_SECRET_PREVIOUS` **只参与解密，永不用于加密**，因此新的写入立刻
 * 使用新密钥。重新加密完历史数据后即可删除该变量。
 * 支持逗号分隔多个历史密钥，便于跨多轮轮换。
 */

/** 非生产环境的固定默认值；生产永远不会用它。 */
const DEV_FALLBACK_SECRET = "roveframe-dev-secret";

let warnedDevFallback = false;

function derive(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret).digest();
}

function isProduction(): boolean {
  return (
    process.env.COZE_PROJECT_ENV === "PROD" ||
    process.env.NODE_ENV === "production"
  );
}

/** 当前加密密钥。生产缺配置即拒绝服务（fail-closed）。 */
function getKey(): Buffer {
  const explicit = process.env.ENCRYPTION_SECRET;
  if (explicit) return derive(explicit);

  if (isProduction()) {
    throw new Error(
      "ENCRYPTION_SECRET is required in production. Provide a dedicated secret " +
        "distinct from COZE_SUPABASE_SERVICE_ROLE_KEY, otherwise rotating that " +
        "database credential would permanently invalidate every stored credential.",
    );
  }

  if (!warnedDevFallback) {
    warnedDevFallback = true;
    console.warn(
      "[crypto] ENCRYPTION_SECRET is not set — using the built-in development " +
        "default. This is non-production only; never deploy without it.",
    );
  }
  return derive(DEV_FALLBACK_SECRET);
}

/**
 * 解密候选密钥：当前密钥优先，随后是只读的历史密钥。
 * 历史密钥**绝不**用于加密。
 */
function getDecryptionKeys(): Buffer[] {
  const keys: Buffer[] = [getKey()];
  const previous = process.env.ENCRYPTION_SECRET_PREVIOUS;
  if (previous) {
    for (const entry of previous.split(",")) {
      const trimmed = entry.trim();
      if (trimmed) keys.push(derive(trimmed));
    }
  }
  return keys;
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
  const keys = getDecryptionKeys();

  let lastError: unknown = null;
  for (const key of keys) {
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
      decipher.setAuthTag(Buffer.from(tagB64, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(dataB64, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch (error) {
      // GCM tag mismatch under the wrong key is expected while trying candidates.
      lastError = error;
    }
  }
  throw lastError ?? new Error("decrypt failed: no usable encryption key");
}

export function mask(secret: string | null | undefined): string {
  if (!secret) return "";
  if (secret.length <= 8) return "****";
  return `${secret.slice(0, 4)}****${secret.slice(-4)}`;
}
