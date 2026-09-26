import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 品牌字标（ROVE/FRAME）必须是**设计好的字形位图**，而不是用字体拼出来的近似品。
 *
 * ## 实测缺陷（2026-09-25）
 *
 * 用户指出线上落地页的 logo 与真实品牌字标不一致。查证：
 *
 * - `src/components/marketing/landing-page.tsx` 页头是 `Sparkles` 图标 + 纯文本
 *   `RoveFrame`（`text-sm font-semibold`），完全不是品牌字形；
 * - `src/components/layout/brand-logo.tsx` 的 `primary` 变体是用系统字体拼的
 *   `ROVE` + skew 斜杠 + `FRA`/`ME`，同样复刻不出定制字形（分离式 R 腿、尖顶 A）。
 *
 * 也就是说**同一产品里有两套互不相同的品牌呈现**，且两套都不是真字标。
 *
 * ## 为什么要断言「透明通道」与「宽高比」
 *
 * 页头背景是主题相关的（顶栏 `bg-card`、落地页 `bg-background`，深色主题会变深）。
 * 一张白底 JPEG 换到深色主题就是一个白色方块 —— 所以必须带 alpha。
 * 位图还必须保持字标的横排长条比例；一旦有人误换成方形图标，比例断言会立刻变红。
 *
 * 这两条都能失败：白底图 → 颜色类型不是 6；方形图 → 宽高比 < 8。
 */

const WORDMARKS = {
  light: join('public', 'brand', 'roveframe-wordmark-light.png'),
  dark: join('public', 'brand', 'roveframe-wordmark-dark.png'),
} as const;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 直接读 PNG 头，避免为一个结构断言引入图像库。 */
function readPngHeader(file: string) {
  const buf = readFileSync(file);
  return {
    bytes: buf.length,
    signatureOk: buf.subarray(0, 8).equals(PNG_SIGNATURE),
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    //: 24 = 位深, 25 = 颜色类型。6 = truecolour + alpha（我们要求的）
    colorType: buf[25] as number,
  };
}

describe('品牌字标资源', () => {
  for (const [variant, file] of Object.entries(WORDMARKS)) {
    test(`${variant} 版存在、是合法 PNG、带透明通道`, () => {
      assert.ok(existsSync(file), `缺失品牌字标：${file}`);
      const h = readPngHeader(file);
      assert.equal(h.signatureOk, true, `${file} 不是 PNG`);
      assert.equal(
        h.colorType,
        6,
        `${file} 的颜色类型是 ${h.colorType}，应为 6（truecolour+alpha）—— ` +
          '没有透明通道的位图在深色主题下会显示成白色方块',
      );
      assert.ok(h.bytes > 1024, `${file} 只有 ${h.bytes} B，疑似占位文件`);
    });

    test(`${variant} 版是横排字标比例（不是方形图标）`, () => {
      const h = readPngHeader(file);
      const ratio = h.width / h.height;
      assert.ok(
        ratio > 8,
        `${file} 宽高比 ${ratio.toFixed(2)}:1，字标应约为 9.84:1 —— ` +
          '比例突变通常意味着误换成了图标或裁切错误',
      );
    });
  }

  test('两版尺寸一致（同一字形的两次配色，不应出现尺寸漂移）', () => {
    const a = readPngHeader(WORDMARKS.light);
    const b = readPngHeader(WORDMARKS.dark);
    assert.equal(a.width, b.width, '两版宽度不一致 —— 主题切换会导致布局跳动');
    assert.equal(a.height, b.height, '两版高度不一致 —— 主题切换会导致布局跳动');
  });
});

describe('品牌只有一处定义', () => {
  const brandLogo = readFileSync(join('src', 'components', 'layout', 'brand-logo.tsx'), 'utf8');

  test('primary 变体引用两版字标，并用 dark: 变体切换', () => {
    assert.match(
      brandLogo,
      /\/brand\/roveframe-wordmark-light\.png/,
      'brand-logo.tsx 未引用浅色版字标',
    );
    assert.match(
      brandLogo,
      /\/brand\/roveframe-wordmark-dark\.png/,
      'brand-logo.tsx 未引用深色版字标',
    );
    assert.match(brandLogo, /dark:hidden/, '缺少浅色版的 dark:hidden');
    assert.match(brandLogo, /dark:block/, '缺少深色版的 dark:block');
  });

  test('落地页不再自己拼品牌，改用共用组件', () => {
    const landing = readFileSync(
      join('src', 'components', 'marketing', 'landing-page.tsx'),
      'utf8',
    );
    assert.match(
      landing,
      /<RoveFrameLogo\b/,
      '落地页未使用共用的 RoveFrameLogo —— 品牌又会分叉成两套',
    );
    assert.doesNotMatch(
      landing,
      />\s*RoveFrame\s*</,
      '落地页仍有写死的 RoveFrame 文本字标，与共用组件重复',
    );
  });

  test('primary 变体不再用字体拼字（tracking-widest 那套）', () => {
    // 负向对照：这个断言在旧实现下必须变红 —— 旧代码里有 skew-x-[-12deg] 的假斜杠。
    assert.doesNotMatch(
      brandLogo,
      /skew-x-\[-12deg\]/,
      'primary 变体又回到用字体拼字标了',
    );
  });
});
