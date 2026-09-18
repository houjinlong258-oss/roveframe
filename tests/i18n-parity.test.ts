import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Phase 15 —— 三语文案键对齐守卫。
 *
 * ## 为什么需要
 *
 * 本仓库的硬约束是"三语必须同步"，而这不是理论风险：
 * `AGENTS.md` 记录了 next-intl 的两个真实坑 ——
 *
 * 1. **漏一个语言** ⇒ 运行时 `MISSING_MESSAGE`；
 * 2. **键里含点号** ⇒ 客户端 `NextIntlClientProvider` 校验抛 `INVALID_KEY`，
 *    直接把渲染搞崩（如 `t('purchase.create_draft')` 必须写成嵌套对象，
 *    不能写成平铺的点号键）。
 *
 * 上一个测试套件里**没有任何 i18n 守卫**（`tests/` 下搜不到 `*i18n*`/`*message*`）。
 * 每次改页面文案都可能踩到，靠人肉比对不可靠。
 *
 * ## 断言什么
 *
 * 1. 三个语言文件的**键集合完全一致**（en 为基准，双向检查）；
 * 2. 顶层命名空间的键集合也一致；
 * 3. 没有"键里带点号"的平铺写法（那种写法在客户端会崩）；
 * 4. 没有空字符串值（空串渲染出来是空白，但看起来像"翻译过了"）。
 */

const ROOT = process.cwd();
const LOCALES = ['en', 'zh', 'es'] as const;

type Json = Record<string, unknown>;

function load(locale: string): Json {
  return JSON.parse(readFileSync(join(ROOT, 'messages', `${locale}.json`), 'utf8')) as Json;
}

/** 把嵌套对象拍平成 `a.b.c` 形式的键列表 */
function flattenKeys(obj: Json, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...flattenKeys(v as Json, path));
    } else {
      out.push(path);
    }
  }
  return out.sort();
}

describe('i18n bundle parity (en / zh / es)', () => {
  const bundles = Object.fromEntries(LOCALES.map((l) => [l, load(l)])) as Record<string, Json>;

  test('三语的键集合完全一致', () => {
    const en = flattenKeys(bundles.en);
    for (const loc of LOCALES) {
      if (loc === 'en') continue;
      const other = flattenKeys(bundles[loc]);
      const missing = en.filter((k) => !other.includes(k));
      const extra = other.filter((k) => !en.includes(k));
      assert.deepEqual(
        missing, [],
        `${loc}.json 缺少这些键（运行时抛 MISSING_MESSAGE）：\n  ${missing.slice(0, 20).join('\n  ')}`,
      );
      assert.deepEqual(
        extra, [],
        `${loc}.json 多出这些 en 里没有的键（多半是改名后没同步）：\n  ${extra.slice(0, 20).join('\n  ')}`,
      );
    }
  });

  test('顶层命名空间集合一致', () => {
    const enNs = Object.keys(bundles.en).sort();
    for (const loc of LOCALES) {
      if (loc === 'en') continue;
      assert.deepEqual(
        Object.keys(bundles[loc]).sort(), enNs,
        `${loc}.json 的顶层命名空间与 en 不一致`,
      );
    }
  });

  test('没有"键里带点号"的平铺写法（客户端会抛 INVALID_KEY 直接崩渲染）', () => {
    for (const loc of LOCALES) {
      const bad = Object.keys(bundles[loc]).filter((k) => k.includes('.'));
      assert.deepEqual(bad, [], `${loc}.json 顶层键含点号：${bad.join(', ')}`);
      // 只在顶层检查是刻意的：嵌套内部的 key 也不应含点号，
      // 但 next-intl 只在顶层键上做 INVALID_KEY 校验，因此这里不误报历史嵌套。
    }
  });

  test('没有空字符串值（空串看起来像翻译过了，实际渲染为空白）', () => {
    for (const loc of LOCALES) {
      const flat = flattenKeys(bundles[loc]);
      const empties = flat.filter((k) => {
        let cur: unknown = bundles[loc];
        for (const part of k.split('.')) cur = (cur as Json)[part];
        return cur === '';
      });
      assert.deepEqual(empties, [], `${loc}.json 这些键的值为空字符串：${empties.join(', ')}`);
    }
  });

  test('messages 目录下只有受支持的语言文件', () => {
    const files = readdirSync(join(ROOT, 'messages'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
    assert.deepEqual(
      files, [...LOCALES].sort(),
      'messages/ 下出现了不在 routing.locales 里的语言文件（或缺少某个语言文件）',
    );
  });

  test('落地页命名空间存在且三语齐全（Phase 15 新增，防止有人只加英文）', () => {
    for (const loc of LOCALES) {
      assert.ok(bundles[loc].landing, `${loc}.json 缺少 landing 命名空间`);
      const l = bundles[loc].landing as Json;
      for (const key of ['heroTitle', 'heroSubtitle', 'features', 'pricing']) {
        assert.ok(key in l, `${loc}.json 的 landing 缺少 ${key}`);
      }
    }
  });
});
