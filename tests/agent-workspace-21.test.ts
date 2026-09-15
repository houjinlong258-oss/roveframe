import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildDeliverable,
  detectDeliverables,
  slugifyTitle,
} from '../src/lib/artifacts/deliverable';
import { parseMarkdownDocument, stripInlineMarkdown, toSlides } from '../src/lib/artifacts/markdown-doc';
import { classifyModelCapability, classifyModelStrength } from '../src/lib/ai/model-registry';
import { summarizeApprovalPayload, toApprovalCard } from '../src/lib/agent/approval-card';
import {
  approvalIdsIn,
  approvalMarker,
  splitConversationSegments,
  stripInternalMarkers,
} from '../src/lib/agent/stream-events';
import { extensionForMime, sniffImageMime } from '../src/lib/ai/image-generation';

/* ------------------------------------------------------------------ */
/* 交付意图识别：真实故障回归 —— 老板要 PDF，就必须产出 PDF              */
/* ------------------------------------------------------------------ */

test('a plain "generate a PDF report" request is detected as PDF', () => {
  const requests = detectDeliverables('根据我的企业情况生成一个PDF经营分析报告');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].format, 'pdf');
});

test('Word / Excel / PPT requests are detected individually', () => {
  assert.deepEqual(detectDeliverables('把这份数据导出成 Excel 表格').map((r) => r.format), ['xlsx']);
  assert.deepEqual(detectDeliverables('我要 word 版本').map((r) => r.format), ['docx']);
  assert.deepEqual(detectDeliverables('生成一个 PPT 汇报').map((r) => r.format), ['pptx']);
});

test('a bare format word without a verb still counts', () => {
  assert.deepEqual(detectDeliverables('pdf').map((r) => r.format), ['pdf']);
  assert.deepEqual(detectDeliverables('excel').map((r) => r.format), ['xlsx']);
});

test('an unspecified "report" defaults to Word + PDF', () => {
  const formats = detectDeliverables('帮我写一份经营分析报告').map((r) => r.format);
  assert.deepEqual(formats.sort(), ['docx', 'pdf']);
});

test('"all formats / bundle" expands to the full document set', () => {
  const formats = detectDeliverables('把这份分析打包成所有格式').map((r) => r.format);
  for (const expected of ['docx', 'pdf', 'xlsx', 'pptx', 'html']) {
    assert.ok(formats.includes(expected as never), `bundle should include ${expected}`);
  }
  // 「打包」同时要一个归档
  assert.ok(formats.includes('zip' as never), 'bundle should include a zip archive');
});

test('zip alone is a valid request', () => {
  const formats = detectDeliverables('把刚才那些文件打包成压缩包').map((r) => r.format);
  assert.ok(formats.includes('zip' as never));
});

test('image intent is routed to the image capability', () => {
  const requests = detectDeliverables('帮我生成一张营销海报');
  assert.equal(requests.some((r) => r.format === 'png'), true);
});

test('a normal question produces no deliverable', () => {
  assert.deepEqual(detectDeliverables('本周营收怎么样？'), []);
  assert.deepEqual(detectDeliverables(''), []);
  assert.deepEqual(detectDeliverables('你好'), []);
});

test('a no-verb mention of a document word does not trigger a file', () => {
  // 「报告」出现在提问里但没有请求动词 → 不应该产出文件
  assert.deepEqual(detectDeliverables('这个报告里哪一项最值得关注'), []);
});

test('slugifyTitle strips unsafe filename characters', () => {
  // 不安全字符先被换成空格，再折叠成下划线 —— 结果必须能直接当文件名
  const slug = slugifyTitle('a/b:c*d?e"f<g>h|i');
  assert.equal(slug, 'a_b_c_d_e_f_g_h_i');
  assert.doesNotMatch(slug, /[\\/:*?"<>|]/);
  assert.ok(slugifyTitle('   ').length > 0);
  assert.ok(slugifyTitle('../../etc/passwd').length > 0);
  assert.doesNotMatch(slugifyTitle('../../etc/passwd'), /\//);
});

/* ------------------------------------------------------------------ */
/* Markdown → 文档结构                                                 */
/* ------------------------------------------------------------------ */

const SAMPLE = `# Sichuan House 经营诊断报告

本报告基于真实经营数据。

## 一、营收概况

近 7 天营收 $551，环比下降。

- 今日营收 $0
- 昨日营收 $84

| 指标 | 数值 | 环比 |
|------|------|------|
| 近7天营收 | $551 | - |
| 今日营收 | $0 | -100% |

## 二、建议

优先修复**曝光不足**问题。

\`\`\`
raw code block
\`\`\`
`;

test('parseMarkdownDocument extracts title, subtitle, sections, bullets and tables', () => {
  const parsed = parseMarkdownDocument(SAMPLE, 'fallback');
  assert.equal(parsed.title, 'Sichuan House 经营诊断报告');
  assert.equal(parsed.subtitle, '本报告基于真实经营数据。');
  assert.ok(parsed.sections.length >= 2);
  assert.equal(parsed.tables.length, 1);
  assert.deepEqual(parsed.tables[0].columns, ['指标', '数值', '环比']);
  assert.equal(parsed.tables[0].rows.length, 2);
  assert.equal(parsed.tables[0].rows[0][0], '近7天营收');

  const bullets = parsed.sections.flatMap((section) => section.bullets ?? []);
  assert.ok(bullets.includes('今日营收 $0'));
  assert.ok(bullets.includes('昨日营收 $84'));
});

test('inline markdown is stripped but text is preserved', () => {
  assert.equal(stripInlineMarkdown('**bold** and `code`'), 'bold and code');
  assert.equal(stripInlineMarkdown('[link](https://x.test)'), 'link');
  assert.equal(stripInlineMarkdown('![alt](img.png)'), 'alt');
});

test('toSlides turns each section into a slide', () => {
  const parsed = parseMarkdownDocument(SAMPLE, 'fallback');
  const slides = toSlides(parsed);
  assert.ok(slides.length >= 3);
  assert.equal(slides[0].title, 'Sichuan House 经营诊断报告');
  assert.ok(slides.some((slide) => slide.title.includes('营收概况')));
});

test('an empty document still yields one usable section', () => {
  const parsed = parseMarkdownDocument('', 'Fallback');
  assert.equal(parsed.title, 'Fallback');
  assert.equal(parsed.sections.length, 1);
});

/* ------------------------------------------------------------------ */
/* 产物构建：模型不参与，运行时保证能出文件                             */
/* ------------------------------------------------------------------ */

const BUILD_INPUT = {
  parsed: parseMarkdownDocument(SAMPLE, 'Report'),
  footer: 'Generated by RoveFrame AI COO',
};

test('docx / xlsx / csv / md / txt / json / html / pptx all build real bytes', () => {
  for (const format of ['docx', 'xlsx', 'csv', 'md', 'txt', 'json', 'html', 'pptx'] as const) {
    const built = buildDeliverable(format, BUILD_INPUT);
    assert.equal(built.ok, true, `${format} should build: ${JSON.stringify(built)}`);
    if (!built.ok) continue;
    assert.ok(built.data.length > 0, `${format} should not be empty`);
    assert.equal(built.ext, format);
    assert.ok(built.mime.length > 0);
  }
});

test('pptx output is a valid OOXML zip (PK header)', () => {
  const built = buildDeliverable('pptx', BUILD_INPUT);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.data.subarray(0, 2).toString('ascii'), 'PK');
  assert.ok(built.data.includes(Buffer.from('ppt/presentation.xml')));
});

test('docx and xlsx outputs are OOXML zips too', () => {
  for (const format of ['docx', 'xlsx'] as const) {
    const built = buildDeliverable(format, BUILD_INPUT);
    assert.equal(built.ok, true);
    if (!built.ok) continue;
    assert.equal(built.data.subarray(0, 2).toString('ascii'), 'PK', format);
  }
});

test('unsupported deliverable formats fail loudly instead of silently', () => {
  const built = buildDeliverable('png' as never, BUILD_INPUT);
  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.equal(built.reason, 'unsupported_format');
});

/* ------------------------------------------------------------------ */
/* 模型能力分类：真实故障回归 —— 图像模型不能再被当聊天模型              */
/* ------------------------------------------------------------------ */

test('image / video / audio / embedding models are not classified as chat', () => {
  // 这条来自真实账本：agnes-image-2.0-flash 被当聊天模型用，连续 4 次 400
  assert.equal(classifyModelCapability('agnes-image-2.0-flash'), 'image');
  assert.equal(classifyModelCapability('agnes-2.0-flash'), 'chat');
  assert.equal(classifyModelCapability('agnes-video-2.5-flash'), 'video');
  assert.equal(classifyModelCapability('agnes-2.5-flash'), 'chat');
  assert.equal(classifyModelCapability('deepseek-v4-flash'), 'chat');
  assert.equal(classifyModelCapability('deepseek-v4-flash-vision-exp'), 'chat');
  assert.equal(classifyModelCapability('text-embedding-3-small'), 'embedding');
  assert.equal(classifyModelCapability('whisper-1'), 'audio');
  assert.equal(classifyModelCapability('gpt-4o'), 'chat');
  assert.equal(classifyModelCapability('claude-sonnet-4-5'), 'chat');
});

test('model strength grouping is stable for the configured models', () => {
  assert.equal(classifyModelStrength('deepseek-v4-pro'), 'reasoning');
  assert.equal(classifyModelStrength('claude-sonnet-4-5'), 'coding');
  assert.equal(classifyModelStrength('agnes-2.5-flash'), 'fast');
  assert.equal(classifyModelStrength('gpt-4o'), 'vision');
  assert.equal(classifyModelStrength('deepseek-v4-flash'), 'fast');
});

/* ------------------------------------------------------------------ */
/* 审批卡片：载荷脱敏 + 标记回放                                        */
/* ------------------------------------------------------------------ */

test('approval payload summary keeps scalars and redacts secrets', () => {
  const summary = summarizeApprovalPayload({
    audience_size: 86,
    expected_revenue: 12000,
    channel: 'email',
    api_key: 'sk-should-not-leak',
    customers: [{ name: 'a' }, { name: 'b' }],
    nested: { deep: true },
  });
  assert.equal(summary.audience_size, 86);
  assert.equal(summary.expected_revenue, 12000);
  assert.equal(summary.api_key, '[redacted]');
  // 数组只报长度，不把客户名单灌进聊天记录
  assert.equal(summary.customers_count, 2);
  // 嵌套对象不展开
  assert.equal('nested' in summary, false);
  assert.doesNotMatch(JSON.stringify(summary), /sk-should-not-leak/);
});

test('toApprovalCard sets canDecide from the required role', () => {
  const row = {
    id: '11111111-1111-4111-8111-111111111111',
    action_type: 'marketing.create_draft_campaign',
    title: 'Customer win-back campaign',
    description: null,
    risk_level: 'medium',
    required_role: 'manager',
    status: 'pending',
    payload: { audience_size: 86 },
    created_at: '2026-09-10T15:25:00.000Z',
  };
  const asOwner = toApprovalCard(row, 'owner');
  assert.equal(asOwner?.canDecide, true);
  const asStaff = toApprovalCard(row, 'staff');
  assert.equal(asStaff?.canDecide, false);
  assert.equal(asStaff?.riskLevel, 'medium');
});

test('an approval row with unknown risk/role falls back safely', () => {
  const card = toApprovalCard(
    {
      id: 'x',
      action_type: 'a',
      title: 't',
      description: null,
      risk_level: 'nonsense',
      required_role: 'nonsense',
      status: 'pending',
      payload: {},
      created_at: '',
    },
    'owner',
  );
  assert.equal(card?.riskLevel, 'medium');
  assert.equal(card?.requiredRole, 'manager');
});

test('approval markers round-trip through the conversation segmenter', () => {
  const approvalId = '22222222-2222-4222-8222-222222222222';
  const artifactId = '33333333-3333-4333-8333-333333333333';
  const content = `Done.\n\n${approvalMarker(approvalId)}\n\nHere is the file:\n\n<<artifact:${artifactId}>>\n`;
  assert.deepEqual(approvalIdsIn(content), [approvalId]);
  const segments = splitConversationSegments(content);
  assert.deepEqual(
    segments.map((segment) => segment.type),
    ['text', 'approval', 'text', 'artifact'],
  );
  assert.equal(segments[1].value, approvalId);
  assert.equal(segments[3].value, artifactId);
});

test('internal markers never leak into generated document content', () => {
  // 回归：正文在流式阶段被塞进标记，若直接拿去生成 Word/PDF，标记会进正式文件
  const content = `营收概览\n\n<<artifact:33333333-3333-4333-8333-333333333333>>\n\n${approvalMarker('22222222-2222-4222-8222-222222222222')}\n\n结论`;
  const cleaned = stripInternalMarkers(content);
  assert.doesNotMatch(cleaned, /<<artifact/);
  assert.doesNotMatch(cleaned, /<<approval/);
  assert.match(cleaned, /营收概览/);
  assert.match(cleaned, /结论/);
});

test('the chat route strips markers before building deliverables', () => {
  const source = readFileSync(join(process.cwd(), 'src/app/api/agent/chat/route.ts'), 'utf8');
  assert.match(source, /answer: stripInternalMarkers\(full\)/);
});

/* ------------------------------------------------------------------ */
/* 图像字节嗅探：不信任上游 content-type                                */
/* ------------------------------------------------------------------ */

test('sniffImageMime detects real formats from magic bytes', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const gif = Buffer.from('GIF89a');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
  assert.equal(sniffImageMime(png), 'image/png');
  assert.equal(sniffImageMime(jpeg), 'image/jpeg');
  assert.equal(sniffImageMime(gif), 'image/gif');
  assert.equal(sniffImageMime(webp), 'image/webp');
  assert.equal(sniffImageMime(Buffer.from('not an image')), 'image/png');
  assert.equal(extensionForMime('image/jpeg'), 'jpg');
  assert.equal(extensionForMime('image/png'), 'png');
});

/* ------------------------------------------------------------------ */
/* 架构约束：能力由运行时决定，不能交回给模型                            */
/* ------------------------------------------------------------------ */

test('the chat route no longer lets the model decide file capabilities', () => {
  const source = readFileSync(join(process.cwd(), 'src/app/api/agent/chat/route.ts'), 'utf8');
  // 系统提示词必须明确禁止模型自称不支持某格式
  assert.match(source, /绝对不要[\s\S]{0,40}我不支持生成/);
  assert.match(source, /NEVER say "I can't generate/);
  // 交付由运行时执行
  assert.match(source, /deliverRequestedFiles\(/);
  // 底层错误不许直接进聊天文案
  assert.match(source, /AI 服务正在自动切换备用引擎/);
  // 审批卡片必须落标记，刷新后仍在
  assert.match(source, /approvalMarker\(card\.id\)/);
});
