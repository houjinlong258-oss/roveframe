/**
 * 生成 Web Push VAPID keypair（web-push 库）。
 * 运行：node scripts/generate-vapid.mjs
 * 输出公私钥后写入环境变量：WEB_PUSH_VAPID_PUBLIC_KEY /
 * WEB_PUSH_VAPID_PRIVATE_KEY / WEB_PUSH_VAPID_SUBJECT，并同步
 * NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY（客户端订阅用）。
 */
import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();
console.log('WEB_PUSH_VAPID_PUBLIC_KEY=' + keys.publicKey);
console.log('WEB_PUSH_VAPID_PRIVATE_KEY=' + keys.privateKey);
console.log('WEB_PUSH_VAPID_SUBJECT=mailto:owner@example.com');
console.log('NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY=' + keys.publicKey);
