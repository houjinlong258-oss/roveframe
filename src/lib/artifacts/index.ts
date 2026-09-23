/**
 * Artifacts 门面：把「模型输出」变成「可下载的真实文件」。
 *
 * 两条交付路径，互为补充：
 * 1. `ArtifactStreamFilter` —— 模型主动用 ```artifact: 围栏时，流式摘出来（可选路径）；
 * 2. `deliverable.ts` —— 运行时按**用户原话**决定格式并生成（保证路径，不依赖模型能力）。
 *
 * 失败的产物不会中断回答：编译/上传失败只记 warning，
 * 并把原始围栏内容还给调用方（绝不静默丢用户内容）。
 */

import {
  extractArtifactFences,
  type ExtractedArtifact,
} from '@/lib/artifacts/protocol';
import {
  buildArtifactFile,
  putArtifact,
  type ArtifactRecord,
  type ArtifactScope,
  type ArtifactSource,
} from '@/lib/artifacts/store';

export * from '@/lib/artifacts/protocol';
export * from '@/lib/artifacts/deliverable';
export * from '@/lib/artifacts/markdown-doc';
export * from '@/lib/artifacts/pdf-writer';
export * from '@/lib/artifacts/extract';
export {
  ALLOWED_UPLOAD_EXTENSIONS,
  ARTIFACT_BUCKET,
  MAX_EXTRACT_BYTES,
  buildArtifactFile,
  deleteArtifact,
  ensureArtifactBucket,
  formatFromName,
  getArtifact,
  getArtifactsByIds,
  isArtifactId,
  isTextualArtifact,
  listArtifacts,
  mimeForFormat,
  readArtifactBytes,
  readArtifactText,
  signArtifact,
  type ArtifactRecord,
  type ArtifactScope,
  type ArtifactSource,
} from '@/lib/artifacts/store';

export interface MaterializeContext {
  sessionId?: string | null;
  agent?: string | null;
  source?: ArtifactSource;
}

export interface MaterializeResult {
  records: ArtifactRecord[];
  warnings: string[];
}

/** 编译并上传一批产物。任何单个失败都不影响其他产物。 */
export async function materializeArtifacts(
  scope: ArtifactScope,
  artifacts: readonly ExtractedArtifact[],
  context: MaterializeContext = {},
): Promise<MaterializeResult> {
  const records: ArtifactRecord[] = [];
  const warnings: string[] = [];
  for (const artifact of artifacts) {
    try {
      const { data, mime } = buildArtifactFile(artifact.format, artifact.fileName, artifact.body);
      const record = await putArtifact(scope, {
        name: artifact.fileName,
        format: artifact.format,
        data,
        mime,
        source: context.source ?? 'agent',
        agent: context.agent ?? null,
        sessionId: context.sessionId ?? null,
        title: artifact.fileName.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '),
      });
      records.push(record);
    } catch (error) {
      warnings.push(
        `${artifact.fileName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { records, warnings };
}

/**
 * 历史回放：从已落库正文里抽出所有围栏并物化（仅用于修复/迁移场景）。
 * 正常运行不需要它 —— 实时流由 ArtifactStreamFilter 处理。
 */
export async function materializeFromText(
  scope: ArtifactScope,
  text: string,
  context: MaterializeContext = {},
): Promise<MaterializeResult & { cleanedText: string }> {
  const parsed = extractArtifactFences(text);
  const result = await materializeArtifacts(scope, parsed.artifacts, context);
  return { ...result, cleanedText: parsed.text };
}
