/**
 * 一次性脚本：用指定 ENCRYPTION_SECRET 按 src/lib/crypto.ts 同款算法加密任意明文。
 * 用法: ENCRYPTION_SECRET=... PLAINTEXT='{"secretKey":"sk_test_..."}' node scripts/encrypt-with-secret.mjs
 * 输出密文与 round-trip 校验结果；明文只经环境变量传入，不落盘。
 */
import crypto from 'node:crypto';

const secret = process.env.ENCRYPTION_SECRET;
const plain = process.env.PLAINTEXT;
if (!secret || !plain) {
  console.error('ENCRYPTION_SECRET and PLAINTEXT are required');
  process.exit(1);
}

const key = crypto.createHash('sha256').update(secret).digest();
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
const tag = cipher.getAuthTag();
const ciphertext = `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;

const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv.toString('base64'), 'base64'));
decipher.setAuthTag(Buffer.from(tag.toString('base64'), 'base64'));
const roundTripOk = Buffer.concat([decipher.update(Buffer.from(encrypted.toString('base64'), 'base64')), decipher.final()]).toString('utf8') === plain;

console.log(JSON.stringify({ ciphertext, round_trip_ok: roundTripOk }));
process.exit(roundTripOk ? 0 : 2);
