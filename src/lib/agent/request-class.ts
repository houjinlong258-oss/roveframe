/**
 * 请求分类 —— 决定 Runtime 不可用时能否降级（Step 3 任务 2）。
 *
 * 背景
 * ----
 * Runtime 挂掉时，「我该不该用 TS 兜底路径回话」的答案**取决于用户要什么**：
 *
 * - **chat**：只是问答。TS 兜底路径能给出有价值的回答 → 允许降级，
 *   但必须发 `runtime_status: fallback` 让用户看见。
 * - **tool_execution**：要动文件 / 跑命令 / 部署 / 生成媒体 / 调插件。
 *   TS 兜底路径**没有这些工具**（`src/lib/agent/tools/index.ts` 只有读业务数据
 *   与建审批单的工具）。此时降级等于**假装做过**——正是「Developer Agent 假响应」
 *   投诉的根因。因此必须**失败**并返回 `unavailable`。
 *
 * 设计取向：**保守**。宁可把工具类请求误判为 chat（退化为降级 + 明确提示），
 * 也不要把普通问答误判为 tool_execution（无谓地让用户看到失败）。
 * 因此这里只匹配**明确的动作意图**，不匹配名词性提及。
 */

export type RequestClass = 'chat' | 'tool_execution';

/** 工具类请求的子类，用于提示文案与审计。 */
export type ToolIntent = 'file' | 'terminal' | 'process' | 'deploy' | 'media' | 'plugin';

/**
 * 动作意图规则。
 *
 * 每条都用「动词 + 宾语」或「明确的工具名」形态，避免把讨论误判为执行：
 * - 命中：`帮我把 src/app.tsx 改一下`、`读一下 README`、`跑一下测试`
 * - 不命中：`部署有哪些最佳实践`（名词性提问）
 */
const TOOL_INTENT_RULES: ReadonlyArray<{ intent: ToolIntent; patterns: RegExp[] }> = [
  {
    intent: 'file',
    patterns: [
      /\b(?:read|open|edit|modify|write|create|delete|rename|move|patch)\s+(?:the\s+)?(?:file|files|code|repo|repository|source|src|module|component|config)\b/i,
      // 「读/看/改」+ 文件名词：覆盖 `read the README`、`open the changelog`
      // 这类没写 "file" 字样但显然是文件操作的表达。
      /\b(?:read|open|edit|modify|write|patch)\s+(?:the\s+|my\s+|our\s+)?(?:readme|changelog|config|configuration|manifest|lockfile|schema|migration)\b/i,
      /\b(?:read_file|write_file|search_files|patch)\b/i,
      /(?:读取|打开|编辑|修改|写入|创建|删除|重命名|移动|打补丁).{0,12}(?:文件|代码|源码|仓库|目录|配置)/,
      /(?:文件|代码|源码|仓库).{0,8}(?:改|修|写|读|删)/,
      /\b[\w.-]+\.(?:tsx?|jsx?|py|json|ya?ml|md|sql|css|html|sh|toml)\b/,
      /(?:读|看|改|修)一下\s*\S*\.(?:tsx?|jsx?|py|md)/,
    ],
  },
  {
    intent: 'terminal',
    patterns: [
      /\b(?:run|execute|exec)\s+(?:the\s+)?(?:command|commands|script|scripts|tests?|test suite|build|lint|migration)\b/i,
      /\b(?:shell|bash|zsh|powershell|ssh|terminal)\b/i,
      /(?:执行|运行|跑)(?:一下)?(?:命令|脚本|测试|构建|编译|迁移)/,
      /(?:终端|命令行|服务器上)/,
    ],
  },
  {
    intent: 'process',
    patterns: [
      /\b(?:restart|stop|kill|start)\s+(?:the\s+)?(?:service|services|server|process|processes|daemon|container)\b/i,
      /\b(?:systemctl|pm2|supervisor|service\s+\w+\s+(?:start|stop|restart))\b/i,
      /(?:重启|停止|杀掉|启动)(?:一下)?(?:服务|进程|容器|守护进程)/,
    ],
  },
  {
    intent: 'deploy',
    patterns: [
      /\b(?:deploy|release|rollback|roll\s+back)\s+(?:the\s+)?(?:app|application|service|build|to\s+prod(?:uction)?|version)\b/i,
      /\b(?:docker|kubernetes|k8s|helm|terraform)\b/i,
      /(?:部署|发布|上线|回滚)(?:一下)?(?:应用|服务|版本|到)/,
    ],
  },
  {
    intent: 'media',
    patterns: [
      /\b(?:generate|create|make|draw)\s+(?:an?\s+)?(?:image|picture|photo|poster|logo|banner|video|clip|audio|music|voiceover|voice\s?over|speech)\b/i,
      /\b(?:text-to-image|text-to-video|tts|image_generate|video_generate)\b/i,
      /(?:生成|做|画|来)(?:一张|一幅|一个|一段|一份)?(?:图片|图|海报|logo|标志|视频|短片|音频|音乐|语音|配音)/,
    ],
  },
  {
    intent: 'plugin',
    patterns: [
      /\b(?:plugin|plugins|extension|extensions|mcp|toolset|toolsets)\b/i,
      /(?:插件|扩展|工具集)/,
    ],
  },
];

export interface RequestClassification {
  requestClass: RequestClass;
  /** 命中的工具意图；chat 时为 null */
  intent: ToolIntent | null;
  /** 命中的原文片段（审计/调试用） */
  matched: string | null;
}

/**
 * 判定一个用户消息属于 chat 还是 tool_execution。
 *
 * 纯函数、无副作用、确定性 —— 可单测、可回放。
 */
export function classifyRequest(message: string): RequestClassification {
  const text = message ?? '';
  if (!text.trim()) return { requestClass: 'chat', intent: null, matched: null };

  for (const rule of TOOL_INTENT_RULES) {
    for (const pattern of rule.patterns) {
      const match = pattern.exec(text);
      if (match) {
        return {
          requestClass: 'tool_execution',
          intent: rule.intent,
          matched: match[0].slice(0, 80),
        };
      }
    }
  }
  return { requestClass: 'chat', intent: null, matched: null };
}

/** 工具意图的用户可读名称（用于提示与审计）。 */
export const TOOL_INTENT_LABEL: Record<ToolIntent, string> = {
  file: 'file',
  terminal: 'terminal',
  process: 'process',
  deploy: 'deploy',
  media: 'media',
  plugin: 'plugin',
};
