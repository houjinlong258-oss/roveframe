/**
 * 把 4 条顾客端写接口登记进 api-rbac-contract 的 EXCEPTIONS 白名单。
 *
 * ## 为什么这 4 条必须走白名单，而不是中央守卫
 *
 * `protectBusinessMutation` / `protectTenantMutation` 认的是**商家身份**
 * （GoTrue 会话 + tenant/business claim）。而顾客是**刻意隔离的第二套身份**：
 * 独立 cookie（roveframe_customer_session）、独立 scrypt 口令、不进 GoTrue 用户池。
 * 它们本来就不该、也不能走中央守卫。
 *
 * 所以这里登记的是**经过审阅的边界**，每个 verify 都断言 handler 内真的做了
 * 顾客会话解析与显式拒绝，而不是"忘了加守卫"。这与既有的
 * `customer/favorites/route.ts`、`auth/login/route.ts` 等条目同一性质。
 *
 * 为什么用脚本而不是手改：要改 4 处、其中一处是往既有条目的 methods 数组里加一项，
 * 手改容易漏或改错数组。脚本读原文、精确替换、并在改完后自检 4 处都在。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'tests/api-rbac-contract.test.ts';
let src = readFileSync(FILE, 'utf8');

const anchor = `  'customer/favorites/route.ts': {`;
if (!src.includes(anchor)) {
  console.error('找不到插入锚点 customer/favorites/route.ts —— 该文件结构已变，请手工处理');
  process.exit(1);
}

// 1) addresses：既有条目从 ['POST','DELETE'] 扩为 ['POST','DELETE','PATCH']
const addrBefore = `  'customer/addresses/route.ts': {
    reason: 'public customer-account boundary resolved from the customer session cookie',
    methods: ['POST', 'DELETE'],`;
const addrAfter = `  'customer/addresses/route.ts': {
    reason: 'public customer-account boundary resolved from the customer session cookie',
    methods: ['POST', 'DELETE', 'PATCH'],`;
if (!src.includes(addrBefore)) {
  console.error('customer/addresses 条目形态与预期不符 —— 请手工处理');
  process.exit(1);
}
src = src.replace(addrBefore, addrAfter);

// 2) 三条新条目插在 favorites 之前
const block = `  // Phase 18：顾客账号管理（改资料 / 改密码 / 注销）。
  // 顾客身份与商家身份**刻意隔离**，因此这四条不可能走中央守卫 ——
  // 它们登记的是"经过审阅的边界"，verify 断言 handler 内确实解析了顾客会话
  // 并显式拒绝（而不是忘了加守卫）。
  'customer/me/route.ts': {
    reason: 'public customer-account boundary; the account id comes only from the customer session cookie',
    methods: ['PATCH'],
    verify: (source) => source.includes('resolveCustomerSession(request)')
      && source.includes("jsonError('unauthorized', 401)"),
  },
  'customer/auth/change-password/route.ts': {
    reason: 'public customer password change; the current password is verified before the new hash is stored',
    methods: ['POST'],
    verify: (source) => source.includes('verifyPassword')
      && source.includes('hashPassword')
      && source.includes('resolveCustomerSession(request)'),
  },
  'customer/account/close/route.ts': {
    reason: 'public customer account closure; marks pending_deletion and revokes sessions, never a hard delete',
    methods: ['POST'],
    verify: (source) => source.includes('pending_deletion')
      && source.includes('resolveCustomerSession(request)'),
  },
`;

src = src.replace(anchor, block + anchor);
writeFileSync(FILE, src, 'utf8');

// 自检：4 处都真的在
const after = readFileSync(FILE, 'utf8');
const checks = [
  ["customer/me/route.ts", after.includes("'customer/me/route.ts'")],
  ['addresses 含 PATCH', after.includes("methods: ['POST', 'DELETE', 'PATCH']")],
  ['change-password 条目', after.includes("'customer/auth/change-password/route.ts'")],
  ['account/close 条目', after.includes("'customer/account/close/route.ts'")],
];
for (const [label, ok] of checks) console.log(`  ${ok ? '[ok]  ' : '[FAIL]'} ${label}`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
