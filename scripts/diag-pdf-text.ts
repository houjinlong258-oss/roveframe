/**
 * 只读诊断：把某个产物的字节结构 + `extractText` 的真实判定一并打印出来。
 *
 * 用途：老板反馈「AI 说读不了我上传的 PDF」时，用它区分三种情况——
 *   ① 文件真没有文本层（扫描件）
 *   ② 有文本层但解码器不支持（过滤器链/编码问题）→ 我们的 bug
 *   ③ 抽取正常，问题在上层内联逻辑
 *
 * 约定：结论**只以 `extractText` 为准**（它实现了完整的过滤器链），
 * 不要用本脚本早期的「只试 inflate」判断，那会误报成扫描件。
 */

import { getSupabaseClient } from '../src/storage/database/supabase-client';
import { canExtract, extractText } from '../src/lib/artifacts/extract';

const BUCKET = 'agent-artifacts';
const TENANT = '00000000-0000-0000-0000-000000000000';
const BUSINESS = '00000000-0000-0000-0000-000000000001';

async function main() {
  const artifactId = process.argv[2];
  if (!artifactId) throw new Error('usage: tsx scripts/diag-pdf-text.ts <artifact-id>');

  const storage = getSupabaseClient().storage.from(BUCKET);
  const prefix = `${TENANT}/${BUSINESS}/${artifactId}`;

  const manifestRes = await storage.download(`${prefix}/_artifact.json`);
  if (manifestRes.error || !manifestRes.data) throw new Error('manifest missing');
  const manifest = JSON.parse(await manifestRes.data.text()) as { name: string; format: string };

  const fileRes = await storage.download(`${prefix}/${manifest.name}`);
  if (fileRes.error || !fileRes.data) throw new Error('file missing');
  const data = Buffer.from(await fileRes.data.arrayBuffer());

  console.log(`artifact : ${manifest.name}  (format=${manifest.format})`);
  console.log(`bytes    : ${data.length}`);
  console.log(`head     : ${JSON.stringify(data.subarray(0, 100).toString('latin1'))}`);

  const latin = data.toString('latin1');
  const count = (re: RegExp) => (latin.match(re) ?? []).length;
  const filters = Array.from(latin.matchAll(/\/Filter\s*(\[[^\]]*\]|\/\w+)/g)).map((m) => m[1]);

  console.log('\n=== 结构统计 ===');
  console.log('  obj        :', count(/\d+\s+0\s+obj/g));
  console.log('  stream     :', count(/\bstream\b/g));
  console.log('  /Font      :', count(/\/Font/g));
  console.log('  /Image     :', count(/\/Subtype\s*\/Image/g));
  console.log('  Tj/TJ      :', count(/\b(Tj|TJ)\b/g));
  console.log('  ToUnicode  :', count(/ToUnicode/g));
  console.log('  filters    :', JSON.stringify(filters.slice(0, 10)));

  if (!canExtract(manifest.format)) {
    console.log(`\n结论：格式 ${manifest.format} 不在抽取器支持范围内（先下载后人工查看）。`);
    return;
  }

  console.log('\n=== extractText 判定（唯一权威结论）===');
  const result = extractText(manifest.format, data, { maxChars: 2000 });
  console.log(`  ok=${result.ok} strategy=${result.strategy} warning=${result.warning}`);
  console.log(`  characters=${result.meta.characters} pages=${result.meta.pages ?? '-'} truncated=${result.truncated}`);
  if (result.text.trim()) {
    console.log('\n--- 抽取到的文本（前 600 字）---');
    console.log(result.text.slice(0, 600));
  }

  console.log('\n=== 判读 ===');
  if (result.ok && result.warning === 'scanned-pdf-no-text-layer') {
    console.log('① 文件确实没有文本层（扫描件/图片型）—— 应如实告知用户，不做 OCR。');
  } else if (!result.ok || result.warning) {
    console.log(`② 有内容但没读全（${result.warning}）—— 属于抽取器能力缺口，看 warning 里的过滤器/编码名。`);
  } else {
    console.log('③ 抽取正常。若用户仍看到「读不了」，问题在上层内联逻辑，不在抽取器。');
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
