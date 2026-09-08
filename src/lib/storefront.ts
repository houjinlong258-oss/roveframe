import { getSupabaseClient } from '@/storage/database/supabase-client';

export interface PublicStoreContext {
  tenantId: string;
  businessId: string;
  tableNo: string;
  qrCodeId: string;
}

/** Client retry keys are deliberately conservative: bounded and header-safe. */
export function isValidIdempotencyKey(value: string): boolean {
  return /^[A-Za-z0-9._:-]{8,128}$/.test(value);
}

/** Resolves a public QR token. Tenant and table labels never come from client input. */
export async function resolvePublicStore(token: string | null): Promise<PublicStoreContext | null> {
  if (!token || !/^[a-f0-9]{32,64}$/i.test(token)) return null;
  const { data, error } = await getSupabaseClient()
    .from('store_qr_codes')
    .select('id, tenant_id, business_id, table_no')
    .eq('public_token', token)
    .eq('is_active', true)
    .maybeSingle();
  if (error || !data || typeof data.business_id !== 'string' || !data.business_id) return null;
  return {
    qrCodeId: data.id as string,
    tenantId: data.tenant_id as string,
    businessId: data.business_id,
    tableNo: data.table_no as string,
  };
}
