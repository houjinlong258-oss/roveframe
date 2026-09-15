# Phase 4 Complete — Media Hub + Document Runtime

**日期**：2026-09-12
**自主执行**：未逐项询问；未删核心模块、未改安全模型、未用生产密钥、未新增依赖。
**前置**：`docs/phase3-plugin-center-sandbox-report.md`

---

## 完成内容

### 扫描结论（再次改变了实现策略）

按要求先扫描媒体与文档能力面，结论：

| 面 | 实测 | 决定 |
|---|---|---|
| 图像 provider | **8 个**（fal / openai / xai / deepinfra / krea / openrouter / nous / …），全部 `available=False`（缺凭据） | 复用 `core/image_gen_registry` |
| 视频 provider | **3 个**（fal / xai / deepinfra） | 复用 `core/video_gen_registry` |
| 音频 provider | `core/tts_registry` 存在；`text_to_speech` 已注册 | 复用 |
| `image_generate` | **已注册**（Phase 1 重建），props `[prompt, aspect_ratio, image_url, reference_image_urls]` | 直接调用 |
| `video_generate` | **未注册**（本路径下） | 委托 + 结构化失败 |
| 文档（TS） | `artifacts/` **9 个文件**，`pdf-writer.ts` 70KB 含字体子集化，`artifacts-pdf.test.ts` 32 测试 | 复用，不重写 |
| 文档（Python） | 34 个 docx/pdf/pptx/xlsx 脚本（属 skills_library） | 不接（TS 侧已是交付路径） |
| 中文字体 | `public/fonts/` **只有 README.md**，0 字体 | 本阶段处理 |

**关键陷阱**：第一次扫描显示 `0 provider` —— 因为 provider 是**插件**，
注册发生在插件发现阶段。必须先触发 `_ensure_plugins_discovered()`。
不触发就误判「没有媒体能力」。这一点已写进 `media_hub._ensure_plugins()`。

### Phase 4a：Media Hub 统一接口 ★

新增 `api/media_hub.py`，把三类媒体收进一个名字空间：

```python
media_status()          → 三类可用性 + provider 明细 + agent 合法路径
generate_image(prompt, aspect_ratio, image_url, reference_image_urls)
generate_video(prompt, aspect_ratio, image_url, duration)
generate_audio(text, provider, output_path)
edit_media(kind, prompt, source)
```

**统一返回形状**（失败时 `reason` 一定非空且可执行）：

```python
{"ok": bool, "kind": "image|video|audio", "provider": str,
 "asset": str|None, "model": str, "reason": str, "via": str}
```

**边界设计（重要）**：Media Hub 是**服务层 facade**，直接调用 provider，
**不经过 `EnterpriseToolGate`**。因此它**只对服务端内部代码开放** ——
绝不能被 agent 直接调用，否则会绕过「高风险操作必须审批」。

`media_status()` 会把这条边界显式写回结果（`agent_path` 字段 +
`note`），避免以后有人误把 facade 接到 agent 上。agent 生成媒体的
**唯一合法路径**是已注册工具（经 gate）：

```
image_generate  → toolset image_gen → gate
video_generate  → toolset video_gen → gate
text_to_speech  → toolset tts       → gate
```

**「不假装成功」**：视频编辑在工具层未暴露（`video_generate` 明确拒绝
edit/extend），因此 `edit_media(VIDEO, ...)` **如实返回不支持**，
而不是静默降级或伪造结果。音频编辑同理（TTS registry 只做合成）。

### Phase 4b：`image_generate` 真实端到端验证 ★

**背景**：Phase 1 从 **0 字节**重建了 `image_generation_tool.py`，
但本机无任何媒体 provider 凭据，当时**只验证了「注册成功」**，
调用链完全未验证。

本阶段用一个继承 `ImageGenProvider` 的内存 fake provider
（注册进既有 registry）把整条链路走通：

```
Media Hub / image_generate_tool
  → image_gen_registry.get_active_provider()
  → provider.generate()
  → 统一响应形状
```

**实测 22/22 通过**，覆盖：

- `image_generate_tool` 返回成功 + image URL + provider 标注 + model 填充
- `aspect_ratio` 规范化（`square`）
- 底层 provider **确实收到 prompt**
- `check_image_generation_requirements()` 由 FAIL 变 **PASS**
- **图片编辑路由**：`image_url` 存在 → `modality="image"`，且 URL 透传到 provider
- Media Hub 回传统一形状（`ok/kind/provider/asset/model/reason` 全集）
- `media_status()` 反映 `image: True`
- **失败路径全部结构化**：空 prompt 被拒并给原因；video/audio 无 provider
  时给出「Known providers: [...]，请配置凭据」；video 编辑如实拒绝

**顺带确认一个 registry 契约**：`register_provider()` 用 `isinstance` 校验，
自定义 provider **必须继承 `ImageGenProvider`**（实测不继承会抛
`TypeError`）。这写进了探针注释，便于以后写 provider 的人少踩一次。

### Phase 4c：中文字体供给器 ★

**问题**：`discoverPdfFont()` 的候选顺序是
①显式路径 ②`RF_PDF_FONT` ③`public/fonts` ④Linux 字体目录 ⑤Windows 字体。
本机（Windows）实测 ⑤ 命中 `C:\WINDOWS\Fonts\msyh.ttc`
（**30209 glyphs**），中文 PDF 正常产出：

```
FONT_PATH=C:\WINDOWS\Fonts\msyh.ttc
FAMILY=Microsoft YaHei
GLYPHS=30209
written bytes -> 134163
pdf header -> "%PDF-1.7"
[verdict] 中文 PDF 生成成功（字体已嵌入）
```

**但生产部署在 Linux** —— 精简镜像通常**没有** `NotoSansCJK*`，
于是中文 PDF 静默降级为 `pdf_font_unavailable`。

新增 `scripts/setup-cjk-font.mjs`：

- **零下载、零新增依赖**：只复制本机**已存在**的字体
- **默认 dry-run**，`--apply` 才写入
- **跨平台候选**：Linux Noto/Source Han/wqy/Droid → Windows simhei/msyh/simsun → macOS PingFang

**★ 合规护栏（默认开启）**：脚本默认**拒绝**复制不可自由分发的字体。
实测本机首选候选是 `simhei.ttf`（`proprietary-Microsoft`），
默认行为是 **REFUSED（exit 3）并给出替代方案**：

```
[REFUSED] 该字体许可证为 "proprietary-Microsoft"，不可自由分发。
  推荐做法（生产环境）：
    Debian/Ubuntu : apt-get install fonts-noto-cjk   # OFL-1.1
    Alpine        : apk add font-noto-cjk
    或设置环境变量  : RF_PDF_FONT=<CJK 字体绝对路径>  # 不进仓库，最干净
```

理由：把 Windows 专有字体复制进仓库，**一次 `git add` 就构成再分发**。
本机自用没问题，但那不该是默认行为。需要时显式 `--allow-proprietary`
（并会打 WARN 提示勿提交）。

同时确认：`pdf-writer.ts` **完整支持 `.ttc` 集合字体**
（`line 467`：取第 1 个字体并重建成独立 sfnt），因此
`msyh.ttc` / `simsun.ttc` 都能用，不会因集合格式失败。

---

## 修改文件

| # | 文件 | 动作 |
|---|---|---|
| 1 | `roveagent/api/media_hub.py` | **新建**（统一媒体能力面 + 边界声明） |
| 2 | `scripts/_e2e_media_hub.py` | **新建**（22 项断言，含 fake provider） |
| 3 | `scripts/setup-cjk-font.mjs` | **新建**（字体供给器 + 合规护栏） |
| 4 | `scripts/_scan_media_surface.py` | **新建**（只读扫描） |
| 5 | `scripts/_probe_pdf_font.ts` | **新建**（中文 PDF 实证） |

**未修改**：`core/*_registry.py`、所有 provider 插件、`pdf-writer.ts`、
`deliverable.ts`、`doc-writers.ts`、`EnterpriseToolGate`、`runtime.py`。

**未新增依赖**：`package.json` 未改动（合零依赖硬约束）。

---

## 架构变化

```
                Agent Gateway
                     │
             Capability Router
                     │
              RoveAgent Runtime
                     │
      ┌──────────────┼───────────────┐
    Tools           MCP           Plugins
      │               │               │
      │               │        ┌──────┴───────┐
      │               │        │ Plugin Center │
      │               │        │ Security Env. │
      │               │        └──────────────┘
      ▼               ▼
 ┌──────────────────────────────────────────┐
 │ Command Policy Layer                      │
 └──────────────────┬───────────────────────┘
                    ▼
 ┌──────────────────────────────────────────┐
 │ EnterpriseToolGate（唯一执行门）           │
 └──────────────────┬───────────────────────┘
                    ▼
            Approval → Sandbox
                    │
   ┌────────────────┼─────────────────┐
   ▼                ▼                 ▼
image_gen        video_gen          tts
registry(8)      registry(3)     registry
   └────────────────┴─────────────────┘
                    ▲
        ┌───────────┴────────────┐
        │  Media Hub（新增）      │ ← 服务层 facade，**不经 gate**，仅内部使用
        │  generate_image/video/  │    仅对服务端代码开放
        │  audio / edit_media     │
        └─────────────────────────┘
```

关键性质：**facade 与 agent 路径显式分离**。agent 必须走注册工具（经 gate），
facade 只给服务端内部用 —— 这条边界写在 `media_status().agent_path` 与
`note` 里，是**可审计的声明**而不是口头约定。

---

## 测试结果

```
$ python -m pytest roveagent/api roveagent/tools/permissions_policy_test.py -q
115 passed, 235 subtests passed in 27.81s        （与 Phase 3 持平，无回归）

$ python scripts/_e2e_media_hub.py
[summary] 22/22 checks passed                    （新增，含 fake provider 全链路）

$ pnpm exec tsx --test tests/artifacts-pdf.test.ts
ℹ tests 32  pass 32  fail 0

$ pnpm exec tsc -p tsconfig.json --noEmit
exit 0

$ node scripts/setup-cjk-font.mjs --apply
[REFUSED] exit 3                                 （合规护栏生效）
public/fonts 仍只有 README.md（确认未误写）
```

**中文 PDF 实证**：

```
FONT_PATH=C:\WINDOWS\Fonts\msyh.ttc
GLYPHS=30209
written bytes -> 134163
pdf header -> "%PDF-1.7"
```

---

## 新发现风险

| # | 风险 | 说明 | 处置 |
|---|---|---|---|
| **R20** | **Media Hub facade 绕过 gate** | 它是服务层内部接口，直接调 provider。若被误接到 agent，将绕过审批 | 已在 `media_status()` 显式声明边界（`agent_path` + `note`）。建议后续加「只允许服务端调用」的断言/测试 |
| **R21** | **生产 Linux 缺 CJK 字体** | 中文 PDF 会静默降级。本机 Windows 能跑通，掩盖了这个问题 | 新增 `setup-cjk-font.mjs` 诊断 + 合规复制。**仍属部署步骤**，需在 Linux 环境执行 `--check` 确认 |
| **R22** | 全部 11 个媒体 provider 均 `available=False` | 无凭据。Media Hub 与工具的**接线**已验证，但**上游真实生成**从未验证 | 需真实 API key（属「需要生产密钥」，不擅自使用）。接入任一 provider 后跑 `_e2e_media_hub.py` 即可 |
| R2/R3 | `video_generate`/`tts`/`vision` 未注册或缺凭据 | 本阶段确认：这三个工具在**内核路径下未注册**（非仅凭据问题） | 需单独排查注册链（`video_generation_tool` 有 `registry.register`，但内核里未生效） |
| R7 | DB 迁移未应用 | 未变 | 有凭据环境执行 |
| R8 | TS→浏览器未经运行时验证 | 未变 | 提供 `.env` |
| R9 | 仓库既有失败测试 | 未变 | 建议清理 |
| R17/R18/R19 | 见 Phase 3 报告 | 未变 | — |

**R22 值得强调**：Phase 4 验证的是**接线与契约**（这是本机唯一能做的事），
**不是上游厂商行为**。我在报告与代码注释里都写明了这一点，没有把
「fake provider 跑通」当作「媒体生成可用」。

---

## 下一步：Phase 5（Search System）

按目标模式继续。Phase 5 计划：

1. **统一搜索接口**：`search()` / `extract()` / `summarize()`
   —— 复用既有 `core/web_search_registry` 与 8 个搜索后端
   （brave-free / ddgs / exa / firecrawl / keenable / parallel / searxng / xai）
   与 `plugins/web/keyless_mcp.py` 的**免密钥** Exa/Parallel 公共 MCP 端点
2. **三类搜索**：Web（既有）/ Document（RAG，已有 `match_doc_chunks`）/
   Enterprise（业务数据，已有 `business` toolset）
3. **验证**：免密钥后端应该能**真实联网搜索**（这是本阶段唯一能拿到真实
   外部结果的路径，因为不需要 API key）

继续推进。
