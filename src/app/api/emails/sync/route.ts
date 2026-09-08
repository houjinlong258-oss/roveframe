import { NextRequest, NextResponse } from 'next/server';
import { syncImapAccount } from '@/lib/email/imap-sync';
import { protectBusinessMutation } from '@/lib/mutation-guard';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { scopedTable } from '@/lib/tenant-db';

async function syncInbox(request: NextRequest): Promise<NextResponse> {
  const context = requireBusinessContext(await getTenantContext(request));
  requirePermission(context, 'emails:write');
  const body = await request.json().catch(() => ({})) as { account_id?: unknown };
  const accountId = typeof body.account_id === 'string' ? body.account_id : null;
  let query = scopedTable(context, 'email_accounts', 'id, tenant_id, business_id, email, imap_host, imap_port, credentials_encrypted')
    .eq('status', 'active').not('imap_host', 'is', null).limit(5);
  if (accountId) query = query.eq('id', accountId);
  const accounts = await query;
  if (accounts.error) return NextResponse.json({ error: accounts.error.message }, { status: 500 });
  if (!accounts.data?.length) return NextResponse.json({ error: 'no active IMAP account found' }, { status: 409 });
  let scanned = 0;
  let imported = 0;
  const errors: { account_id: string; error: string }[] = [];
  for (const raw of accounts.data) {
    const account = raw as Parameters<typeof syncImapAccount>[0];
    try {
      const result = await syncImapAccount(account);
      scanned += result.scanned;
      imported += result.imported;
    } catch (error) {
      errors.push({ account_id: account.id, error: error instanceof Error ? error.message : 'IMAP sync failed' });
    }
  }
  return NextResponse.json({ ok: errors.length === 0, scanned, imported, errors }, { status: errors.length === accounts.data.length ? 502 : 200 });
}

export const POST = protectBusinessMutation(
  { permission: 'emails:write', action: 'emails.imap.sync', entity: 'emails' },
  syncInbox,
);
