import { json, jsonError, errorResponse, getForwardHeaders } from '@/lib/api-helpers';
import { chunkText, embedText } from '@/lib/embedding';
import { getTenantContext, requireBusinessContext } from '@/lib/tenant';
import {
  deleteWithScope,
  insertWithScope,
  scopedTable,
  updateWithScope,
} from '@/lib/tenant-db';
import { protectBusinessMutation, type BusinessMutationContext } from '@/lib/mutation-guard';

/** 文档分块向量化（异步执行，失败置 error 状态） */
async function vectorizeDoc(
  context: BusinessMutationContext,
  docId: string,
  content: string,
  forwardHeaders?: Record<string, string>,
) {
  try {
    const chunks = chunkText(content);
    for (let i = 0; i < chunks.length; i++) {
      const embedding = await embedText(chunks[i], forwardHeaders);
      const { error } = await insertWithScope(context, 'doc_chunks', {
        doc_id: docId,
        chunk_index: i,
        content: chunks[i],
        embedding: JSON.stringify(embedding),
      });
      if (error) throw new Error(error.message);
    }
    await updateWithScope(context, 'knowledge_docs', docId, {
      status: 'ready',
      updated_at: new Date().toISOString(),
    });
  } catch {
    await updateWithScope(context, 'knowledge_docs', docId, { status: 'error' });
  }
}

export async function GET(request: Request) {
  try {
    const ctx = requireBusinessContext(await getTenantContext(request));
    const { searchParams } = new URL(request.url);
    const category = searchParams.get('category');

    const q = scopedTable(
      ctx,
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
    return errorResponse(error);
  }
}

async function createDocument(request: Request) {
  try {
    const ctx = requireBusinessContext(await getTenantContext(request));
    const body = (await request.json()) as { title: string; category: string; content: string; industry?: string };
    if (!body.title?.trim() || !body.content?.trim()) return jsonError('title and content required', 400);
    const row: Record<string, string> = {
      title: body.title.trim(),
      category: body.category || 'sop',
      content: body.content,
      status: 'processing',
    };
    // industry 列为可选（见 migrate-production-hardening.sql），未提供时不写入以兼容未迁移环境
    if (body.industry?.trim()) row.industry = body.industry.trim();
    const { data, error } = await insertWithScope(ctx, 'knowledge_docs', row)
      .select('id, title, category, status, created_at, updated_at')
      .single();
    if (error) throw new Error(error.message);
    const inserted = data as { id: string; title: string; category: string; status: string; created_at: string; updated_at: string };
    await vectorizeDoc(ctx, inserted.id, body.content, getForwardHeaders(request));
    return json({ doc: { ...inserted, status: 'ready' } });
  } catch (error) {
    return errorResponse(error);
  }
}

async function updateDocument(request: Request) {
  try {
    const ctx = requireBusinessContext(await getTenantContext(request));
    const body = (await request.json()) as { id: string; title?: string; category?: string; content?: string; industry?: string };
    if (!body.id) return jsonError('missing id', 400);
    const updates: Record<string, string> = { updated_at: new Date().toISOString() };
    if (body.title) updates.title = body.title;
    if (body.category) updates.category = body.category;
    if (body.industry?.trim()) updates.industry = body.industry.trim();
    if (body.content) {
      updates.content = body.content;
      updates.status = 'processing';
      // 删旧 chunks（tenant 内限定）
      const chunksRes = await scopedTable(ctx, 'doc_chunks', 'id').eq('doc_id', body.id);
      const chunkIds = ((chunksRes.data ?? []) as { id: string }[]).map((c) => c.id);
      for (const id of chunkIds) {
        const { error: delErr } = await deleteWithScope(ctx, 'doc_chunks', id);
        if (delErr) throw new Error(delErr.message);
      }
    }
    const { error } = await updateWithScope(ctx, 'knowledge_docs', body.id, updates);
    if (error) throw new Error(error.message);
    if (body.content) await vectorizeDoc(ctx, body.id, body.content, getForwardHeaders(request));
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

async function deleteDocument(request: Request) {
  try {
    const ctx = requireBusinessContext(await getTenantContext(request));
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) return jsonError('missing id', 400);
    // 同时清理 chunks（tenant 内）
    const chunksRes = await scopedTable(ctx, 'doc_chunks', 'id').eq('doc_id', id);
    for (const c of (chunksRes.data ?? []) as { id: string }[]) {
      const { error: delErr } = await deleteWithScope(ctx, 'doc_chunks', c.id);
      if (delErr) throw new Error(delErr.message);
    }
    const { error } = await deleteWithScope(ctx, 'knowledge_docs', id);
    if (error) throw new Error(error.message);
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

export const POST = protectBusinessMutation(
  { permission: 'knowledge:write', action: 'knowledge.create', entity: 'knowledge_docs' },
  createDocument,
);
export const PATCH = protectBusinessMutation(
  { permission: 'knowledge:write', action: 'knowledge.update', entity: 'knowledge_docs' },
  updateDocument,
);
export const DELETE = protectBusinessMutation(
  { permission: 'knowledge:write', action: 'knowledge.delete', entity: 'knowledge_docs' },
  deleteDocument,
);
