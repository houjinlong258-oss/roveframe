import { EmbeddingClient } from 'coze-coding-dev-sdk';

export const EMBEDDING_DIMENSIONS = 1024;

export async function embedText(text: string, forwardHeaders?: Record<string, string>): Promise<number[]> {
  const client = new EmbeddingClient(undefined, forwardHeaders);
  // SDK 类型声明为 number[]，实际运行时返回 { embedding: number[] }，两种形态都兼容
  const result = (await client.embedText(text, { dimensions: EMBEDDING_DIMENSIONS })) as unknown as
    | number[]
    | { embedding: number[] };
  return Array.isArray(result) ? result : result.embedding;
}

/** 长文本分块：按段落切，每块不超过 maxChars */
export function chunkText(text: string, maxChars = 500): string[] {
  const paragraphs = text.split(/\n{2,}|\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  for (const p of paragraphs) {
    if (current.length + p.length + 1 > maxChars && current) {
      chunks.push(current);
      current = p;
    } else {
      current = current ? `${current}\n${p}` : p;
    }
  }
  if (current) chunks.push(current);
  // 超长单段硬切
  return chunks.flatMap((c) => {
    if (c.length <= maxChars) return [c];
    const parts: string[] = [];
    for (let i = 0; i < c.length; i += maxChars) parts.push(c.slice(i, i + maxChars));
    return parts;
  });
}
