import { getSupabaseClient } from '@/storage/database/supabase-client';

export interface BusinessMemory {
  id: string;
  content: string;
  created_at: string;
}

// 取最近的企业长期记忆（注入 AI 上下文）
export async function getRecentMemories(
  tenantId: string,
  businessId: string,
  limit = 5,
): Promise<BusinessMemory[]> {
  const client = getSupabaseClient();
  const query = client
    .from('business_memories')
    .select('id, content, created_at')
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId);
  const { data } = await query
    .order('created_at', { ascending: false })
    .limit(limit);
  return (data ?? []) as BusinessMemory[];
}

// 沉淀一条企业长期记忆
export async function addMemory(
  tenantId: string,
  businessId: string,
  content: string,
): Promise<void> {
  const text = content.trim();
  if (text.length < 4) return;
  const client = getSupabaseClient();
  const { error } = await client.from('business_memories').insert({
    tenant_id: tenantId,
    business_id: businessId,
    content: text,
  });
  if (error) throw new Error(error.message);
}

// 把记忆转成注入提示词的片段
export function memoriesToPrompt(memories: BusinessMemory[], locale: string): string {
  if (memories.length === 0) return '';
  const label =
    locale === 'zh'
      ? '企业长期记忆（历史经验，回答时请自动参考）'
      : 'Long-term business memories (past experience, reference when answering)';
  const items = memories.map((m) => `- ${m.content}`).join('\n');
  return `${label}：\n${items}`;
}
