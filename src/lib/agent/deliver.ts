/**
 * 交付编排 —— 把「用户要什么文件」和「模型写了什么」拼成真实产物。
 *
 * 这是 Agent Workspace 2.1 的核心修复点。真实故障复盘：
 * 老板说「生成一个 PDF 经营分析报告」，模型回答「当前不支持生成 PDF 格式」，
 * 结果一个文件都没交付（数据库里 8 条回复、0 个产物标记）。
 *
 * 根因是架构错误：把「系统能不能生成某格式」交给 LLM 判断。
 * 现在改为——模型只写内容，**运行时按用户原话决定并生成文件**，
 * 模型没有资格说「我不支持」。
 */

import {
  artifactMarker,
  buildDeliverable,
  detectDeliverables,
  parseForDeliverable,
  type DeliverableFormat,
} from '@/lib/artifacts';
import { putArtifact, mimeForFormat, type ArtifactRecord, type ArtifactScope } from '@/lib/artifacts/store';
import { buildZip } from '@/lib/artifacts/doc-writers';
import { extensionForMime, generateImage } from '@/lib/ai/image-generation';
import { discoverPdfFont } from '@/lib/artifacts/pdf-writer';
import type { ModelRegistry } from '@/lib/ai/model-registry';
import type { AgentNoticeEvent } from '@/lib/agent/stream-events';

/** 回答太短就不生成文件（避免「你好」也产出一份空报告） */
const MIN_ANSWER_CHARS = 80;
/** 出图提示词的风格补语（很多图像模型对英文风格词更敏感） */
const IMAGE_STYLE_SUFFIX =
  ', marketing poster for a small business, clean modern layout, clear hierarchy, high quality, promotional';

export interface DeliverInput {
  scope: ArtifactScope;
  /** 用户原话（决定要什么格式） */
  message: string;
  /** 模型写完的 Markdown（决定文件内容） */
  answer: string;
  sessionId: string | null;
  /** persona key，写进产物元数据 */
  agent: string;
  locale: string;
  /** 模型自己用围栏已经产出过的格式，避免重复交付 */
  alreadyProduced: ReadonlySet<string>;
  registry: ModelRegistry | null;
  /** 是否允许出图（图像模型可能未接入） */
  allowImage?: boolean;
}

export interface DeliverOutcome {
  /** 需要追加到落库正文的产物标记 */
  markers: string[];
  artifacts: ArtifactRecord[];
  notices: AgentNoticeEvent[];
}

function t(locale: string, zh: string, en: string, es: string): string {
  if (locale === 'zh') return zh;
  if (locale === 'es') return es;
  return en;
}

/** 各格式生成失败时的可执行提示（不要只说「失败了」） */
function failureNotice(
  format: DeliverableFormat,
  reason: string,
  detail: string,
  locale: string,
): AgentNoticeEvent {
  if (reason === 'pdf_font_unavailable') {
    return {
      type: 'notice',
      level: 'warning',
      code: 'pdf_font_unavailable',
      message: t(
        locale,
        'PDF 需要中文字体才能正确排版，已改用 Word / 网页版交付。管理员把 .ttf 放进 public/fonts/ 后即可直接导出 PDF。',
        'PDF needs an embedded CJK font, so I delivered Word/HTML instead. An admin can drop a .ttf into public/fonts/ to enable PDF export.',
        'El PDF necesita una fuente CJK incrustada; se entregó en Word/HTML. Un administrador puede añadir un .ttf en public/fonts/.',
      ),
      technical: detail,
    };
  }
  return {
    type: 'notice',
    level: 'warning',
    code: `deliver_failed_${format}`,
    message: t(
      locale,
      `生成 ${format.toUpperCase()} 时出错，内容已在对话里完整保留。`,
      `Could not build the ${format.toUpperCase()} file; the full content is in the conversation.`,
      `No se pudo crear el archivo ${format.toUpperCase()}; el contenido está en la conversación.`,
    ),
    technical: detail,
  };
}

/**
 * 交付执行。绝不抛错：单个格式失败只产生一条可见提示，其余格式继续。
 */
export async function deliverRequestedFiles(input: DeliverInput): Promise<DeliverOutcome> {
  const out: DeliverOutcome = { markers: [], artifacts: [], notices: [] };
  const requests = detectDeliverables(input.message);
  if (requests.length === 0) return out;

  const answer = (input.answer ?? '').trim();
  if (answer.length < MIN_ANSWER_CHARS) {
    out.notices.push({
      type: 'notice',
      level: 'info',
      code: 'deliver_skipped_short_answer',
      message: t(
        input.locale,
        '这次回答内容太短，我没有生成文件。让我写成完整报告后再导出即可。',
        'The answer was too short to make a file. Ask for a full report and I will export it.',
        'La respuesta era demasiado corta para generar un archivo.',
      ),
    });
    return out;
  }

  // 只有确实需要文档/表格时才解析（出图不需要）
  const needsParsing = requests.some((request) => request.format !== 'png');
  const parsed = needsParsing
    ? parseForDeliverable(answer, deriveTitle(input.message))
    : null;

  // 文档里有数据表却没人要表格文件 → 顺手补一份 Excel（老板拿到报告通常也要数据）
  if (parsed && parsed.tables.length > 0) {
    const wantsDoc = requests.some((r) => r.format === 'docx' || r.format === 'pdf' || r.format === 'pptx');
    const hasTable = requests.some((r) => r.format === 'xlsx' || r.format === 'csv');
    if (wantsDoc && !hasTable && !input.alreadyProduced.has('xlsx')) {
      requests.push({ format: 'xlsx', fileName: `Data_${Date.now()}.xlsx`, reason: 'tables-detected' });
    }
  }

  let font: ReturnType<typeof discoverPdfFont> | undefined;
  const pdfRequested = requests.some((request) => request.format === 'pdf');
  if (pdfRequested) font = discoverPdfFont();

  /** 供 ZIP 打包复用：本次已构建出的文件字节 */
  const collected: Array<{ name: string; data: Buffer }> = [];

  for (const request of requests) {
    if (input.alreadyProduced.has(request.format)) continue;
    // zip 是收尾步骤，等其余文件都构建完再打包
    if (request.format === 'zip') continue;

    if (request.format === 'png') {
      if (input.allowImage === false) continue;
      const prompt = `${input.message.replace(/^(请|帮我|麻烦|给我)+/g, '').trim()}${IMAGE_STYLE_SUFFIX}`;
      const image = await generateImage(prompt, input.registry ?? emptyRegistry(), input.scope, {});
      if (!image.ok) {
        out.notices.push({
          type: 'notice',
          level: 'warning',
          code: 'image_unavailable',
          message: image.reason === 'no_image_model'
            ? t(
                input.locale,
                '还没有接入可出图的模型，所以本次只给了设计方案。管理员在「设置 → AI 服务商」接入图像模型后，我就能直接出图。',
                'No image-capable model is connected yet, so I delivered a design plan only. Connect one in Settings → AI Providers to get real images.',
                'Aún no hay un modelo de imagen conectado; se entregó solo el diseño.',
              )
            : t(
                input.locale,
                '出图服务这次没有返回结果，已保留设计方案。稍后可以让我重试。',
                'The image service did not return a result this time; the design plan is kept above.',
                'El servicio de imagen no devolvió resultado; se conserva el diseño.',
              ),
          technical: image.message,
        });
        continue;
      }
      try {
        const ext = extensionForMime(image.mime);
        const record = await putArtifact(input.scope, {
          name: request.fileName.replace(/\.png$/i, `.${ext}`),
          format: ext,
          data: image.data,
          mime: image.mime,
          source: 'agent',
          agent: input.agent,
          sessionId: input.sessionId,
          title: deriveTitle(input.message),
        });
        out.artifacts.push(record);
        out.markers.push(artifactMarker(record.id));
      } catch (error) {
        out.notices.push({
          type: 'notice',
          level: 'warning',
          code: 'image_store_failed',
          message: t(
            input.locale,
            '图片生成成功但保存失败，请稍后重试。',
            'The image was generated but could not be saved. Please retry.',
            'La imagen se generó pero no se pudo guardar.',
          ),
          technical: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }

    const built = buildDeliverable(request.format, {
      parsed: parsed ?? parseForDeliverable(answer, deriveTitle(input.message)),
      footer: 'Generated by RoveFrame AI COO',
      font,
    });

    if (!built.ok) {
      out.notices.push(failureNotice(request.format, built.reason, built.message, input.locale));
      continue;
    }

    try {
      const record = await putArtifact(input.scope, {
        name: request.fileName,
        format: built.ext,
        data: built.data,
        mime: built.mime,
        source: 'agent',
        agent: input.agent,
        sessionId: input.sessionId,
        title: deriveTitle(input.message),
      });
      out.artifacts.push(record);
      out.markers.push(artifactMarker(record.id));
      collected.push({ name: record.name, data: built.data });
    } catch (error) {
      out.notices.push(
        failureNotice(request.format, 'store_failed', error instanceof Error ? error.message : String(error), input.locale),
      );
    }
  }

  // ---- 打包：把本次交付的所有文件合成一个归档 ----
  const zipRequested = requests.some((request) => request.format === 'zip');
  if (zipRequested && !input.alreadyProduced.has('zip') && collected.length > 0) {
    try {
      const archiveName = collected.length === 1
        ? `${collected[0].name.replace(/\.[^.]+$/, '')}.zip`
        : `RoveFrame_Deliverables_${new Date().toISOString().slice(0, 10)}.zip`;
      const archive = buildZip(collected);
      const record = await putArtifact(input.scope, {
        name: archiveName,
        format: 'zip',
        data: archive,
        mime: mimeForFormat('zip'),
        source: 'agent',
        agent: input.agent,
        sessionId: input.sessionId,
        title: deriveTitle(input.message),
      });
      out.artifacts.push(record);
      out.markers.push(artifactMarker(record.id));
    } catch (error) {
      out.notices.push({
        type: 'notice',
        level: 'warning',
        code: 'archive_failed',
        message: t(
          input.locale,
          '打包压缩包失败，但各个文件都已单独交付。',
          'Could not build the ZIP archive, but every file was delivered individually.',
          'No se pudo crear el ZIP, pero cada archivo se entregó por separado.',
        ),
        technical: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return out;
}

/** 从用户原话里取一个像标题的片段 */
function deriveTitle(message: string): string {
  const cleaned = (message ?? '')
    .replace(/^(请|帮我|麻烦|给我|我要|我想要|能不能|可以|能否)+/g, '')
    .replace(/\b(pdf|docx|xlsx|pptx|csv|md|html|json|txt|word|excel|ppt|markdown)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 60) || 'Report';
}

/** 没有注册表时出图直接失败（不猜服务商） */
function emptyRegistry(): ModelRegistry {
  return {
    providers: [],
    defaultProvider: null,
    defaultModel: null,
    platformFallback: { provider: 'platform', model: '', label: '' },
    routableProviderIds: [],
    generatedAt: new Date(0).toISOString(),
  };
}
