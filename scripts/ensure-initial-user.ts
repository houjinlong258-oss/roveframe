/**
 * 幂等创建初始登录账号（挂到 seed 的四川人家 business，登录即见全部演示数据）。
 *
 * 用法: pnpm tsx scripts/ensure-initial-user.ts [--email xx@yy.zz] [--password xxx] [--name 名字]
 * 默认: houjinlong258@gmail.com / Rove@2026
 * 已存在同名 auth 用户时仅补齐 public.users 行并重置为传入密码。
 */
import { getSupabaseClient } from '@/storage/database/supabase-client';
import {
  createAuthUserWithTenant,
  createPublicUserRow,
  signInAndGetToken,
} from '@/lib/auth';

const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const DEFAULT_BUSINESS_ID = '00000000-0000-0000-0000-000000000001';

function parseArgs(argv: string[]): { email: string; password: string; name: string } {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    email: get('--email') ?? 'houjinlong258@gmail.com',
    password: get('--password') ?? 'Rove@2026',
    name: get('--name') ?? 'Owner',
  };
}

async function main(): Promise<void> {
  const { email, password, name } = parseArgs(process.argv.slice(2));
  const client = getSupabaseClient();

  // 定位已有 auth 用户（幂等）
  let userId: string | null = null;
  const { data: listed, error: listErr } = await client.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) throw new Error(`listUsers failed: ${listErr.message}`);
  const existing = listed.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (existing) {
    userId = existing.id;
    const { error: updErr } = await client.auth.admin.updateUserById(existing.id, {
      password,
      email_confirm: true,
      app_metadata: { tenant_id: DEFAULT_TENANT_ID, business_id: DEFAULT_BUSINESS_ID },
    });
    if (updErr) throw new Error(`updateUserById failed: ${updErr.message}`);
    console.log(`[init-user] auth user exists, password/claims reset: ${userId}`);
  } else {
    const a = await createAuthUserWithTenant({
      email,
      password,
      tenantId: DEFAULT_TENANT_ID,
      businessId: DEFAULT_BUSINESS_ID,
      name,
    });
    if (!a.ok) throw new Error(`createUser failed: ${a.error}`);
    userId = a.data.userId;
    console.log(`[init-user] auth user created: ${userId}`);
  }

  // public.users 行（幂等）
  const { data: pubRow } = await client
    .from('users')
    .select('id')
    .eq('id', userId)
    .maybeSingle();
  if (!pubRow) {
    const u = await createPublicUserRow({
      id: userId,
      tenantId: DEFAULT_TENANT_ID,
      businessId: DEFAULT_BUSINESS_ID,
      email,
      name,
      role: 'owner',
    });
    if (!u.ok) throw new Error(`createPublicUserRow failed: ${u.error}`);
    console.log('[init-user] public.users row created');
  } else {
    console.log('[init-user] public.users row exists');
  }

  const s = await signInAndGetToken({ email, password });
  if (!s.ok) throw new Error(`login verify failed: ${s.error}`);
  console.log(`[init-user] login verified OK for ${email}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[init-user] FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
