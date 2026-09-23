/**
 * 零依赖 PPTX 写入器。
 *
 * 复用 doc-writers 的 `buildZip` 打出真实 OOXML 包（PowerPoint / WPS / Keynote
 * 均可打开），把文档结构里每个 `## 小节` 渲染成一页幻灯片。
 *
 * 取舍（如实说明）：不做主题、母版占位符继承、动画、图片与图表；
 * 版式用最朴素的标题 + 正文文本框，保证「打开不报错、内容正确」。
 */

import { buildZip } from '@/lib/artifacts/doc-writers';
import { toSlides, type ParsedMarkdown } from '@/lib/artifacts/markdown-doc';

/** 幻灯片尺寸：16:9，单位 EMU（1 inch = 914400 EMU） */
const SLIDE_W = 12_192_000;
const SLIDE_H = 6_858_000;
const MARGIN_X = 838_200;
const TITLE_TOP = 548_640;
const BODY_TOP = 1_600_200;
const BODY_H = SLIDE_H - BODY_TOP - 548_640;

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // XML 1.0 不允许的控制字符
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

/** 一段文字 → DrawingML 段落（rPr 控制字号与颜色） */
function paragraph(text: string, sizePt: number, bullet: boolean, color = '1A1A1A'): string {
  const bulletXml = bullet
    ? '<a:buChar char="•"/>'
    : '<a:buNone/>';
  return [
    '<a:p>',
    `<a:pPr marL="${bullet ? 228600 : 0}" indent="${bullet ? -228600 : 0}">${bulletXml}</a:pPr>`,
    '<a:r>',
    `<a:rPr lang="zh-CN" sz="${Math.round(sizePt * 100)}" b="0" dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:rPr>`,
    `<a:t>${escapeXml(text)}</a:t>`,
    '</a:r>',
    '</a:p>',
  ].join('');
}

function textBox(
  id: number,
  name: string,
  x: number,
  y: number,
  cx: number,
  cy: number,
  paragraphs: string[],
): string {
  return [
    '<p:sp>',
    '<p:nvSpPr>',
    `<p:cNvPr id="${id}" name="${escapeXml(name)}"/>`,
    '<p:cNvSpPr txBox="1"/>',
    '<p:nvPr/>',
    '</p:nvSpPr>',
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`,
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>',
    '<p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:normAutofit/></a:bodyPr><a:lstStyle/>',
    ...paragraphs,
    '</p:txBody>',
    '</p:sp>',
  ].join('');
}

function slideXml(title: string, bullets: string[], paragraphs: string[]): string {
  const titleBox = textBox(
    2,
    'Title',
    MARGIN_X,
    TITLE_TOP,
    SLIDE_W - MARGIN_X * 2,
    900_000,
    [paragraph(title, 30, false, '0D0D0D')],
  );

  const bodyParts: string[] = [];
  for (const line of paragraphs) bodyParts.push(paragraph(line, 16, false));
  for (const line of bullets) bodyParts.push(paragraph(line, 16, true, '333333'));
  const bodyBox = bodyParts.length > 0
    ? textBox(3, 'Body', MARGIN_X, BODY_TOP, SLIDE_W - MARGIN_X * 2, BODY_H, bodyParts)
    : '';

  return [
    XML_HEADER,
    `<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">`,
    '<p:cSld><p:spTree>',
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>',
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>',
    titleBox,
    bodyBox,
    '</p:spTree></p:cSld>',
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>',
    '</p:sld>',
  ].join('');
}

export interface PptxWriteResult {
  data: Buffer;
  mime: string;
  ext: string;
  slideCount: number;
}

/** 把解析好的文档结构写成 .pptx */
export function writePptx(parsed: ParsedMarkdown): PptxWriteResult {
  const slides = toSlides(parsed);
  const parts = slides.length > 0 ? slides : [{ title: parsed.title ?? 'Report', bullets: [], paragraphs: [] }];

  const entries: Array<{ name: string; data: Buffer }> = [];
  const push = (name: string, xml: string) => entries.push({ name, data: Buffer.from(xml, 'utf8') });

  const overrides = parts
    .map((_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`)
    .join('');
  push(
    '[Content_Types].xml',
    `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
      '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
      '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
      '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
      overrides +
      '</Types>',
  );

  push(
    '_rels/.rels',
    `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
      '</Relationships>',
  );

  const slideIdList = parts
    .map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`)
    .join('');
  push(
    'ppt/presentation.xml',
    `${XML_HEADER}<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" saveSubsetFonts="1">` +
      `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
      `<p:sldIdLst>${slideIdList}</p:sldIdLst>` +
      `<p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/><p:notesSz cx="${SLIDE_H}" cy="${SLIDE_W}"/>` +
      '</p:presentation>',
  );

  const presentationRels = parts
    .map((_, index) => `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`)
    .join('');
  push(
    'ppt/_rels/presentation.xml.rels',
    `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>' +
      presentationRels +
      '</Relationships>',
  );

  push(
    'ppt/slideMasters/slideMaster1.xml',
    `${XML_HEADER}<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">` +
      '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
      '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
      '</p:spTree></p:cSld>' +
      '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
      '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
      '</p:sldMaster>',
  );
  push(
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>' +
      '</Relationships>',
  );
  push(
    'ppt/slideLayouts/slideLayout1.xml',
    `${XML_HEADER}<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" type="blank">` +
      '<p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
      '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
      '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>',
  );
  push(
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>' +
      '</Relationships>',
  );
  push(
    'ppt/theme/theme1.xml',
    `${XML_HEADER}<a:theme xmlns:a="${NS_A}" name="RoveFrame">` +
      '<a:themeElements><a:clrScheme name="RoveFrame">' +
      '<a:dk1><a:srgbClr val="0D0D0D"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>' +
      '<a:dk2><a:srgbClr val="1A1A1A"/></a:dk2><a:lt2><a:srgbClr val="F7F5F0"/></a:lt2>' +
      '<a:accent1><a:srgbClr val="A7FF00"/></a:accent1><a:accent2><a:srgbClr val="84CC00"/></a:accent2>' +
      '<a:accent3><a:srgbClr val="16A37B"/></a:accent3><a:accent4><a:srgbClr val="E8930C"/></a:accent4>' +
      '<a:accent5><a:srgbClr val="5C5C5C"/></a:accent5><a:accent6><a:srgbClr val="0D0D0D"/></a:accent6>' +
      '<a:hlink><a:srgbClr val="0D0D0D"/></a:hlink><a:folHlink><a:srgbClr val="5C5C5C"/></a:folHlink>' +
      '</a:clrScheme>' +
      '<a:fontScheme name="RoveFrame"><a:majorFont><a:latin typeface="Plus Jakarta Sans"/><a:ea typeface="Noto Sans SC"/><a:cs typeface=""/></a:majorFont>' +
      '<a:minorFont><a:latin typeface="Plus Jakarta Sans"/><a:ea typeface="Noto Sans SC"/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
      '<a:fmtScheme name="RoveFrame"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
      '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
      '<a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
      '<a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
      '<a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
      '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
      '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
      '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>' +
      '</a:fmtScheme></a:themeElements></a:theme>',
  );

  parts.forEach((slide, index) => {
    push(`ppt/slides/slide${index + 1}.xml`, slideXml(slide.title, slide.bullets, slide.paragraphs));
    push(
      `ppt/slides/_rels/slide${index + 1}.xml.rels`,
      `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
        '</Relationships>',
    );
  });

  return {
    data: buildZip(entries),
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ext: 'pptx',
    slideCount: parts.length,
  };
}
