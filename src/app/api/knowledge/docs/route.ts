import { getSupabaseClient } from '@/storage/database/supabase-client';
import { json, jsonError, getErrorMessage, getForwardHeaders } from '@/lib/api-helpers';
import { chunkText, embedText } from '@/lib/embedding';

/** 文档分块向量化（异步执行，失败置 error 状态） */
async function vectorizeDoc(docId: string, content: string, forwardHeaders?: Record<string, string>) {
  const client = getSupabaseClient();
  try {
    const chunks = chunkText(content);
    for (let i = 0; i < chunks.length; i++) {
      const embedding = await embedText(chunks[i], forwardHeaders);
      const { error } = await client.from('doc_chunks').insert({
        doc_id: docId,
        chunk_index: i,
        content: chunks[i],
        embedding: JSON.stringify(embedding),
      });
      if (error) throw new Error(error.message);
    }
    await client.from('knowledge_docs').update({ status: 'ready', updated_at: new Date().toISOString() }).eq('id', docId);
  } catch {
    await client.from('knowledge_docs').update({ status: 'error' }).eq('id', docId);
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const category = searchParams.get('category');
    const client = getSupabaseClient();
    let query = client
      .from('knowledge_docs')
      .select('id, title, category, content, status, created_at, updated_at')
      .order('updated_at', { ascending: false });
    if (category && category !== 'all') query = query.eq('category', category);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return json({ docs: data ?? [] });
  } catch (error) {
    return jsonError(getErrorMessage(error));
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { title: string; category: string; content: string };
    if (!body.title?.trim() || !body.content?.trim()) return jsonError('title and content required', 400);
    const client = getSupabaseClient();
    const { data, error } = await client
      .from('knowledge_docs')
      .insert({ title: body.title.trim(), category: body.category || 'sop', content: body.content, status: 'processing' })
      .select('id, title, category, status, created_at, updated_at')
      .single();
    if (error) throw new Error(error.message);
    await vectorizeDoc(data.id, body.content, getForwardHeaders(request));
    return json({ doc: { ...data, status: 'ready' } });
  } catch (error) {
    return jsonError(getErrorMessage(error));
  }
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as { id: string; title?: string; category?: string; content?: string };
    if (!body.id) return jsonError('missing id', 400);
    const client = getSupabaseClient();
    const updates: Record<string, string> = { updated_at: new Date().toISOString() };
    if (body.title) updates.title = body.title;
    if (body.category) updates.category = body.category;
    if (body.content) {
      updates.content = body.content;
      updates.status = 'processing';
      await client.from('doc_chunks').delete().eq('doc_id', body.id);
    }
    const { error } = await client.from('knowledge_docs').update(updates).eq('id', body.id);
    if (error) throw new Error(error.message);
    if (body.content) await vectorizeDoc(body.id, body.content, getForwardHeaders(request));
    return json({ ok: true });
  } catch (error) {
    return jsonError(getErrorMessage(error));
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) return jsonError('missing id', 400);
    const client = getSupabaseClient();
    const { error } = await client.from('knowledge_docs').delete().eq('id', id);
    if (error) throw new Error(error.message);
    return json({ ok: true });
  } catch (error) {
    return jsonError(getErrorMessage(error));
  }
}
