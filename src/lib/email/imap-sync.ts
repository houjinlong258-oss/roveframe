import { ImapFlow } from 'imapflow';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import { decrypt } from '@/lib/crypto';
import { getSupabaseClient } from '@/storage/database/supabase-client';

type ImapAccount = {
  id: string;
  tenant_id: string;
  business_id: string;
  email: string;
  imap_host: string | null;
  imap_port: number | null;
  credentials_encrypted: string | null;
};

type ImapCredentials = {
  imap_user?: string;
  imap_pass?: string;
  smtp_user?: string;
  smtp_pass?: string;
  access_token?: string;
};

function firstAddress(value: AddressObject | AddressObject[] | undefined): { address: string; name: string | null } {
  const item = Array.isArray(value) ? value[0] : value;
  const address = item?.value[0];
  return { address: address?.address ?? '', name: address?.name ?? null };
}

export function mapInboundMail(input: {
  parsed: ParsedMail;
  account: ImapAccount;
  externalId: string;
  internalDate?: Date | string;
  seen: boolean;
}): Record<string, unknown> {
  const from = firstAddress(input.parsed.from);
  const to = firstAddress(input.parsed.to);
  const plainText = input.parsed.text?.trim()
    || (typeof input.parsed.html === 'string' ? input.parsed.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '');
  return {
    tenant_id: input.account.tenant_id,
    business_id: input.account.business_id,
    mailbox_id: input.account.id,
    from_addr: from.address || 'unknown@invalid.local',
    from_name: from.name,
    to_addr: to.address || input.account.email,
    subject: (input.parsed.subject?.trim() || '(no subject)').slice(0, 500),
    content: plainText.slice(0, 200_000),
    category: 'other',
    priority: 'medium',
    status: input.seen ? 'read' : 'unread',
    external_id: input.externalId.slice(0, 255),
    created_at: (input.parsed.date ?? (input.internalDate ? new Date(input.internalDate) : new Date())).toISOString(),
  };
}

export async function syncImapAccount(account: ImapAccount): Promise<{ scanned: number; imported: number }> {
  if (!account.imap_host || !account.credentials_encrypted) throw new Error('IMAP account is incomplete');
  const credentials = JSON.parse(decrypt(account.credentials_encrypted)) as ImapCredentials;
  const user = credentials.imap_user || credentials.smtp_user || account.email;
  const password = credentials.imap_pass || credentials.smtp_pass;
  const accessToken = credentials.access_token;
  if (!user || (!password && !accessToken)) throw new Error('IMAP credentials are incomplete');
  const port = account.imap_port ?? 993;
  const client = new ImapFlow({
    host: account.imap_host,
    port,
    secure: port === 993,
    auth: accessToken ? { user, accessToken } : { user, pass: password ?? '' },
    logger: false,
  });
  let scanned = 0;
  let imported = 0;
  try {
    await client.connect();
    const mailbox = await client.mailboxOpen('INBOX', { readOnly: true });
    if (mailbox.exists === 0) return { scanned, imported };
    const start = Math.max(1, mailbox.exists - 199);
    for await (const message of client.fetch(`${start}:*`, {
      uid: true, flags: true, envelope: true, internalDate: true,
      source: { maxLength: 2_000_000 },
    })) {
      scanned += 1;
      if (!message.source) continue;
      const parsed = await simpleParser(message.source, { skipImageLinks: true, skipHtmlToText: false });
      const externalId = parsed.messageId || `${mailbox.uidValidity.toString()}:${message.uid}`;
      const record = mapInboundMail({
        parsed,
        account,
        externalId,
        internalDate: message.internalDate,
        seen: message.flags?.has('\\Seen') ?? false,
      });
      const { data, error } = await getSupabaseClient().from('emails').upsert(record, {
        onConflict: 'tenant_id,business_id,mailbox_id,external_id',
        ignoreDuplicates: true,
      }).select('id').maybeSingle();
      if (error) throw new Error(`Inbound email persistence failed: ${error.message}`);
      if (data?.id) imported += 1;
    }
    return { scanned, imported };
  } finally {
    if (client.usable) await client.logout();
    else client.close();
  }
}
