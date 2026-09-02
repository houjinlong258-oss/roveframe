import { json, jsonError, getErrorMessage, getForwardHeaders } from '@/lib/api-helpers';
import { chunkText, embedText } from '@/lib/embedding';
import { getTenantContext } from '@/lib/tenant';
import {
  deleteWithTenant,
  insertWithTenant,
  tenantTable,
  updateWithTenant,
} from '@/lib/tenant-db';
import { getSupabaseClient } from '@/storage/database/supabase-client';

/** 文档分块向量化（异步执行，失败置 error 状态） */
async function vectorizeDoc(
  tenantId: string,
  docId: string,
  content: string,
  forwardHeaders?: Record<string, string>,
) {
  const client = getSupabaseClient();
  try {
    const chunks = chunkText(content);
    for (let i = 0; i < chunks.length; i++) {
      const embedding = await embedText(chunks[i], forwardHeaders);
      const { error } = await insertWithTenant(tenantId, 'doc_chunks', {
        doc_id: docId,
        chunk_index: i,
        content: chunks[i],
        embedding: JSON.stringify(embedding),
      });
      if (error) throw new Error(error.message);
    }
    await updateWithTenant(tenantId, 'knowledge_docs', docId, {
      status: 'ready',
      updated_at: new Date().toISOString(),
    });
  } catch {
    await updateWithTenant(tenantId, 'knowledge_docs', docId, { status: 'error' });
  }
}

export async function GET(request: Request) {
  try {
    const ctx = getTenantContext(request);
    const { searchParams } = new URL(request.url);
    const category = searchParams.get('category');

    const q = tenantTable(
      ctx.tenantId,
      'knowledge_docs',
      'id, title, category, content, status, created_at, updated_at',
    ).order('updated_at', { ascending: false });
    const chained = category && category !== 'all'
      ? (q as unknown as { eq: (c: string, v: unknown) => typeof q }).eq('category', category)
      : q;
    const { data, error } = await chained;
    if (error) throw new Error(error.message);
    return json({ docs: data ?? [] });
  } catch (error) {
    return jsonError(getErrorMessage(error));
  }
}

export async function POST(request: Request) {
  try {
    const ctx = getTenantContext(request);
    const body = (await request.json()) as { title: string; category: string; content: string };
    if (!body.title?.trim() || !body.content?.trim()) return jsonError('title and content required', 400);
    const { data, error } = await insertWithTenant(ctx.tenantId, 'knowledge_docs', {
      title: body.title.trim(),
      category: body.category || 'sop',
      content: body.content,
      status: 'processing',
    })
      .select('id, title, category, status, created_at, updated_at')
      .single();
    if (error) throw new Error(error.message);
    const inserted = data as { id: string; title: string; category: string; status: string; created_at: string; updated_at: string };
    await vectorizeDoc(ctx.tenantId, inserted.id, body.content, getForwardHeaders(request));
    return json({ doc: { ...inserted, status: 'ready' } });
  } catch (error) {
    return jsonError(getErrorMessage(error));
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = getTenantContext(request);
    const body = (await request.json()) as { id: string; title?: string; category?: string; content?: string };
    if (!body.id) return jsonError('missing id', 400);
    const updates: Record<string, string> = { updated_at: new Date().toISOString() };
    if (body.title) updates.title = body.title;
    if (body.category) updates.category = body.category;
    if (body.content) {
      updates.content = body.content;
      updates.status = 'processing';
      // 删旧 chunks（tenant 内限定）
      const chunksRes = await tenantTable(ctx.tenantId, 'doc_chunks', 'id').eq('doc_id', body.id);
      const chunkIds = ((chunksRes.data ?? []) as { id: string }[]).map((c) => c.id);
      for (const id of chunkIds) {
        const { error: delErr } = await deleteWithTenant(ctx.tenantId, 'doc_chunks', id);
        if (delErr) throw new Error(delErr.message);
      }
    }
    const { error } = await updateWithTenant(ctx.tenantId, 'knowledge_docs', body.id, updates);
    if (error) throw new Error(error.message);
    if (body.content) await vectorizeDoc(ctx.tenantId, body.id, body.content, getForwardHeaders(request));
    return json({ ok: true });
  } catch (error) {
    return jsonError(getErrorMessage(error));
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = getTenantContext(request);
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) return jsonError('missing id', 400);
    // 同时清理 chunks（tenant 内）
    const chunksRes = await tenantTable(ctx.tenantId, 'doc_chunks', 'id').eq('doc_id', id);
    for (const c of (chunksRes.data ?? []) as { id: string }[]) {
      const { error: delErr } = await deleteWithTenant(ctx.tenantId, 'doc_chunks', c.id);
      if (delErr) throw new Error(delErr.message);
    }
    const { error } = await deleteWithTenant(ctx.tenantId, 'knowledge_docs', id);
    if (error) throw new Error(error.message);
    return json({ ok: true });
  } catch (error) {
    return jsonError(getErrorMessage(error));
  }
}
