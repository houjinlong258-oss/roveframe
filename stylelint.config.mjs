/** @type {import('stylelint').Config} */
export default {
  extends: 'stylelint-config-standard',
  /**
   * Phase 18：`src/app/pwa-tier.css` 是**搬运来的第三方样式层**
   * （原型里的 apple-* 玻璃态与 rf-* 布局，约 1700 行），由
   * scripts/_vendor_pwa_assets.mjs 生成。
   *
   * 为什么不逐条改到合规：那是 600+ 处纯风格问题（#FFFFFF 要写 #FFF、
   * rgba() 要写 rgb()、透明度要写百分比），改完不影响任何渲染结果，
   * 却会让这份文件**无法再被脚本重复生成** —— 下次原型的样式更新一跑脚本，
   * 手工修的全丢。
   *
   * 所以这里排除它，而不是把规则放宽到全仓库：`src/` 下其它 CSS 仍然受
   * 同一套严格规则约束。真要清理这份样式，应当先改造原型导出，
   * 再重新 vendor，而不是在副本上手改。
   */
  ignoreFiles: ['src/app/pwa-tier.css'],
  rules: {
    'at-rule-no-unknown': [
      true,
      {
        ignoreAtRules: ['tailwind', 'apply', 'layer', 'theme', 'custom-variant'],
      },
    ],
    'hue-degree-notation': null,
    'import-notation': null,
    'lightness-notation': null,
    'rule-empty-line-before': null,
    'value-keyword-case': null,
  },
};

