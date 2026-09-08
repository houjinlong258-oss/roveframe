/**
 * 一次性脚本：生成 ENCRYPTION_SECRET 并用 src/lib/crypto.ts 同款算法加密 Provider Key。
 * 用法: DEEPSEEK_TEST_KEY=sk-... node scripts/encrypt-provider-key.mjs
 * 输出: 新生成的 ENCRYPTION_SECRET（需配置到部署环境变量）、密文、round-trip 校验结果。
 * 明文密钥只经环境变量传入，不落盘。
 */
import crypto from 'node:crypto';

const plain = process.env.DEEPSEEK_TEST_KEY;
if (!plain) {
  console.error('DEEPSEEK_TEST_KEY not set');
  process.exit(1);
}

const secret = crypto.randomBytes(32).toString('hex');
const key = crypto.createHash('sha256').update(secret).digest();

function encrypt(p) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(p, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
}

function decrypt(payload) {
  const [ivB64, tagB64, dataB64] = payload.split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

const ciphertext = encrypt(plain);
const roundTripOk = decrypt(ciphertext) === plain;

console.log(JSON.stringify({
  encryption_secret: secret,
  ciphertext,
  round_trip_ok: roundTripOk,
  masked_key: `${plain.slice(0, 4)}****${plain.slice(-4)}`,
}, null, 2));
process.exit(roundTripOk ? 0 : 2);
