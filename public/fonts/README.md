# PDF 中文字体

PDF 要正确排版中文，必须把一份 **TrueType 轮廓**的字体嵌进文件里。
`src/lib/artifacts/pdf-writer.ts` 会按下面的顺序自动找字体：

1. `RF_PDF_FONT` 环境变量指向的绝对路径
2. **本目录下的 `*.ttf` / `*.otf` / `*.ttc`（第一个匹配）** ← 推荐放这里
3. 常见 Linux 路径：`/usr/share/fonts/**/NotoSansCJK*`、`wqy-*`、`DroidSansFallback*`
4. 常见 Windows 路径：`C:/Windows/Fonts/msyh.ttc`、`simhei.ttf`、`simsun.ttc`、`arial.ttf`

## 一键准备（推荐）

```bash
node scripts/setup-pdf-font.mjs
```

下载 Noto Sans SC（OFL 许可）到 `public/fonts/report-cjk.ttf`，并校验它确实是
带 `glyf` 表的 sfnt。字体文件会做**字形子集化**，所以源文件大不影响产物体积
（只嵌入实际用到的字）。

## 为什么容器里必须显式准备

开发机上通常有系统字体（Windows 的微软雅黑、macOS 的苹方），但**精简的
Linux 容器往往一个 CJK 字体都没有**。

那种情况下系统不会生成一份排版错乱（豆腐块）的 PDF，而是：

- 在聊天里给出可见提示：PDF 需要中文字体，已改用 Word / 网页版交付；
- 同时仍然交付 `.docx` 与 `.html`，内容完整不缺。

也就是说：**没有字体 = 少一个格式，不会得到坏文件。**

## 不要放的文件

- `.otf` / CFF 轮廓字体（如 Noto Sans CJK 的 OTF 版本）—— PDF 嵌入只支持
  TrueType `glyf` 轮廓，`discoverPdfFont()` 会跳过它们。
- 来源不明或授权不允许再分发的字体。Noto 系列为 OFL，可自由分发。

## 许可

放在本目录的字体由部署方自行负责其授权。若使用 `setup-pdf-font.mjs`，
下载的是 Google Noto Sans SC（SIL Open Font License 1.1）。
