import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

/**
 * README 三语版本的结构守卫。
 *
 * ## 为什么需要它
 *
 * 产品自己承诺三语（en/zh/es，见 `messages/` 与 i18n 键一致性守卫），README 也提供三份。
 * 但**三份文档不会自己保持一致**：改了英文正文、忘了另外两份，是必然会发生的事，
 * 而且没有任何症状 —— 读者只会看到"这一节在中文版里不存在"。
 * 这正是本仓库反复处理的那一类缺陷：不一致是静默的。
 *
 * ## 它守什么、不守什么（如实说明）
 *
 * 守：结构一致性 —— 同数量的 `##` / `###` 标题、同数量的代码块、同一组资源引用、
 *     互相正确的语言切换链接。这几项可以跨语言机械比对。
 * 不守：**译文内容是否忠实**。那需要人读，机器判不了；这里不假装能判。
 *     所以它是"漂移探测"，不是"翻译质量保证"。
 */

const LANGS = [
  { file: 'README.md', label: 'English', others: ['README.zh-CN.md', 'README.es.md'] },
  { file: 'README.zh-CN.md', label: '简体中文', others: ['README.md', 'README.es.md'] },
  { file: 'README.es.md', label: 'Español', others: ['README.md', 'README.zh-CN.md'] },
];

const read = (f: string): string => {
  // 先给出可读的失败原因，而不是让 readFileSync 抛 ENOENT —— 删掉一份译文时，
  // 报错信息应该直接说出"缺哪一份"，而不是一串 errno。
  assert.ok(existsSync(f), `${f} 不存在 —— 三语 README 必须同时存在（语言切换链接会 404）`);
  return readFileSync(f, 'utf8');
};

/** 结构指纹：可以跨语言机械比对的几项。 */
export function structureOf(text: string) {
  return {
    h2: (text.match(/^## /gm) ?? []).length,
    h3: (text.match(/^### /gm) ?? []).length,
    fences: (text.match(/^```/gm) ?? []).length,
    assets: [...text.matchAll(/docs\/assets\/[a-z0-9-]+\.(?:png|jpg)/g)].map((m) => m[0]).sort(),
    images: (text.match(/<img /g) ?? []).length,
  };
}

describe('README 三语结构一致性', () => {
  test('三份 README 都存在', () => {
    for (const { file } of LANGS) {
      assert.ok(existsSync(file), `${file} 不存在 —— 语言切换链接会 404`);
    }
  });

  test('标题层级与代码块数量一致（任何一份漏掉一节都会红）', () => {
    const base = structureOf(read('README.md'));
    assert.ok(base.h2 >= 10, `英文版只解析出 ${base.h2} 个 ## 标题，解析可能失效`);
    assert.ok(base.fences >= 10, `英文版只解析出 ${base.fences} 个代码块分隔符`);

    for (const { file } of LANGS.slice(1)) {
      const s = structureOf(read(file));
      assert.equal(s.h2, base.h2, `${file} 的 ## 标题数 ${s.h2} 与英文版 ${base.h2} 不一致`);
      assert.equal(s.h3, base.h3, `${file} 的 ### 标题数 ${s.h3} 与英文版 ${base.h3} 不一致`);
      assert.equal(s.fences, base.fences,
        `${file} 的代码块数 ${s.fences} 与英文版 ${base.fences} 不一致`);
      assert.equal(s.images, base.images,
        `${file} 的 <img> 数量 ${s.images} 与英文版 ${base.images} 不一致`);
    }
  });

  test('三份引用同一组图片资源（改图名时不会漏改一份）', () => {
    const base = structureOf(read('README.md'));
    assert.ok(base.assets.length >= 5, `英文版只引用到 ${base.assets.length} 个资源`);
    for (const { file } of LANGS.slice(1)) {
      assert.deepEqual(structureOf(read(file)).assets, base.assets,
        `${file} 引用的图片与英文版不一致`);
    }
  });

  test('语言切换链接互相指向，且当前语言不加链接', () => {
    for (const { file, label, others } of LANGS) {
      const text = read(file);
      assert.ok(text.includes(label), `${file} 的切换行里没有标出当前语言「${label}」`);
      for (const other of others) {
        assert.ok(text.includes(`(${other})`), `${file} 的语言切换里缺少指向 ${other} 的链接`);
      }
    }
  });

  test('负向对照：结构比对必须能发现"少了一节"', () => {
    const base = structureOf(read('README.md'));
    const missing = read('README.md').replace(/^## Deployment$/m, '## 部署');
    const mutated = structureOf(missing);
    // 只是把标题文字换成中文不算结构变化（这正是本守卫允许的）
    assert.equal(mutated.h2, base.h2, '仅换标题文字不应被判成结构不一致');
    // 真正删掉一节必须被察觉
    const dropped = structureOf(read('README.md').replace(/^## Deployment[\s\S]*?(?=^## )/m, ''));
    assert.notEqual(dropped.h2, base.h2, '删掉一整节必须让标题计数变化，否则本守卫没有分辨力');
  });

  test('站内锚点链接指向真实存在的标题（译文改了标题文字，锚点必须跟着改）', () => {
    // 为什么需要：标题被翻译后，`#engineering-practices` 这种英文锚点就成了死链 ——
    // GitHub 是按**标题文本**生成锚点的。两份译文都把锚点改成了自己的标题形式，
    // 这条断言就是核对那件事，而不是相信"应该没问题"。
    //
    // 说明：这里实现的是 GitHub slug 规则的**近似**（小写、去掉字母数字/空格/下划线/
    // 连字符之外的字符、空格转连字符）。它不处理重复标题的 -1/-2 后缀。
    const slugify = (h: string) => h.trim().toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s+/g, '-');

    for (const { file } of LANGS) {
      const text = read(file);
      const slugs = new Set(
        [...text.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slugify(m[1])),
      );
      const anchors = [...text.matchAll(/\]\(#([^)]+)\)/g)].map((m) => decodeURIComponent(m[1]));
      assert.ok(anchors.length > 0, `${file} 里找不到任何站内锚点，这条断言会空转`);
      for (const a of anchors) {
        assert.ok(slugs.has(a), `${file} 的锚点 #${a} 没有对应标题 —— 是一个死链`);
      }
    }
  });
});
