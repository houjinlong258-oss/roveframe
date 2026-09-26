/**
 * 任务 → 技能路由：把「这一轮该用哪个技能」变成确定性的匹配，而不是指望模型自己想起来。
 *
 * ## 为什么需要它
 *
 * 运行时会把技能索引（名字 + 描述）放进系统提示词，但**正文要模型自己调
 * `skill_view` 去取**。仓库自己的注释就记着这个弱点
 * （`core/coding_context.py`：models do not reliably reach for `skills_list` to …）——
 * 实测也印证：问 CEO「你有哪些技能」它能一条条列出来，但做具体任务时并不会主动去加载。
 *
 * 于是"装了 18 个技能"和"agent 真的会用"之间差了一步。本模块补这一步：
 * 拿用户这句话去匹配**该租户已装**的技能，把命中的技能名与用途显式写进本轮上下文，
 * 并明确要求先 `skill_view` 再动手。
 *
 * ## 设计约束
 *
 * - **纯函数，不 import 任何东西**：既能被服务端路由使用，也能被单测直接导入。
 * - **确定性**：同样的输入永远给同样的结果（不调模型、不引入随机）。
 * - **宁缺勿滥**：分数不到阈值就不提示 —— 塞一堆无关技能等于给模型加噪音。
 */

export interface SkillHintSource {
  name: string;
  description: string;
  /** 运行时的市场接口会带上该租户是否已装；这里只对已装的做提示。 */
  installed?: boolean;
}

export interface SkillMatch {
  name: string;
  description: string;
  score: number;
  /** 命中的词元（便于排查"为什么匹配到它"） */
  matched: string[];
}

export interface MatchOptions {
  topN?: number;
  minScore?: number;
}

const DEFAULT_TOPN = 3;
const DEFAULT_MIN_SCORE = 4;
/** 单个匹配最多保留多少个命中词（避免把整段描述塞进提示词） */
const MAX_MATCHED_WORDS = 6;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 中文按二字组切分：中文没有词边界，字符二元组是最省事且无需词典的方案。 */
function cjkBigrams(text: string): string[] {
  const segments = text.replace(/[^\u4e00-\u9fa5]+/g, ' ').split(/\s+/).filter((s) => s.length >= 2);
  const out = new Set<string>();
  for (const seg of segments) {
    for (let i = 0; i + 2 <= seg.length; i += 1) out.add(seg.slice(i, i + 2));
  }
  return [...out];
}

/** 给单个技能打分。分数越高越相关；`matched` 说明为什么。 */
function scoreSkill(message: string, skill: SkillHintSource): { score: number; matched: string[] } {
  const msg = (message ?? '').toLowerCase();
  const name = (skill.name ?? '').toLowerCase();
  const description = skill.description ?? '';
  const matched: string[] = [];
  let score = 0;

  // 1) 技能名整体出现 —— 最强的信号（用户/模型直接点名）
  if (name && msg.includes(name)) {
    score += 10;
    matched.push(name);
  }

  // 2) 技能名的词元（如 menu-optimization → menu / optimization）
  for (const token of name.split(/[-_]/)) {
    if (token.length >= 4 && new RegExp(`(^|[^a-z0-9])${escapeRegExp(token)}([^a-z0-9]|$)`).test(msg)) {
      score += 4;
      matched.push(token);
    }
  }

  // 3) 描述里的英文词（≥5 字符，跳过长尾噪音）
  const englishWords = new Set((description.toLowerCase().match(/[a-z][a-z-]{4,}/g) ?? []));
  for (const word of englishWords) {
    if (msg.includes(word)) {
      score += 2;
      matched.push(word);
    }
  }

  // 4) 描述里的中文二字组。
  //
  // 权重与上限都是实测调出来的：中文没有词边界，只能靠二字组，而一个二字组只覆盖
  // 两个字 —— 给 1 分的话「帮我看看菜单毛利，哪些菜该涨价」只命中 菜单/单毛/毛利
  // 共 3 分，被默认阈值 4 滤掉，中文任务整体失效。改成每个 2 分、上限 6 分：
  //   · 「菜单毛利」→ 3 个二字组 = 6 分 ✓
  //   · 「库存…补货」→ 2 个 = 4 分 ✓
  //   · 单个二字组（如只出现「建议」）= 2 分 < 4，仍然不触发（保精度）
  let cjkScore = 0;
  for (const bigram of cjkBigrams(description)) {
    if (msg.includes(bigram)) {
      cjkScore += 2;
      matched.push(bigram);
    }
  }
  score += Math.min(cjkScore, 6);

  return { score, matched: [...new Set(matched)].slice(0, MAX_MATCHED_WORDS) };
}

/**
 * 在**已安装**的技能里挑出与本轮任务最相关的若干个。
 *
 * 只考虑 `installed !== false` 的技能：没装给租户的技能即使名字再像也调不动，
 * 提示它只会让模型去调一个不存在的技能。
 */
export function matchSkills(
  message: string,
  skills: readonly SkillHintSource[],
  options: MatchOptions = {},
): SkillMatch[] {
  const topN = options.topN ?? DEFAULT_TOPN;
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  if (!message || message.trim().length === 0) return [];

  const scored: SkillMatch[] = [];
  for (const skill of skills) {
    if (!skill?.name) continue;
    if (skill.installed === false) continue;
    const { score, matched } = scoreSkill(message, skill);
    if (score < minScore) continue;
    scored.push({ name: skill.name, description: skill.description ?? '', score, matched });
  }

  // 分数相同时按名字排序，保证输出稳定（确定性要求）
  scored.sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name));
  return scored.slice(0, Math.max(0, topN));
}

/**
 * 把命中的技能渲染成本轮上下文里的一段。
 *
 * 措辞刻意带"先读再动手"：只报技能名不解决"模型不去加载"的问题。
 */
export function skillHintsPrompt(matches: readonly SkillMatch[], locale: string): string {
  if (matches.length === 0) return '';
  const zh = locale === 'zh';
  const header = zh
    ? '与本轮任务相关的已装技能（相关时**先用 skill_view 读取其完整步骤**，再按步骤执行；不要凭印象编造步骤）'
    : 'Skills installed for this workspace that match the current request (when relevant, **load with skill_view first** and follow its steps; do not improvise them)';
  const lines = matches.map((m) => `- ${m.name} — ${m.description.slice(0, 160)}`);
  return `${header}:\n${lines.join('\n')}`;
}

/**
 * 安装意图的判定式。**故意收窄**：只有用户明显在"找/装新技能"时才提示。
 *
 * 为什么不能每轮都提示：`fetch` 会去克隆任意 git 仓库。把"你可以联网装技能"写进
 * 每一轮上下文，等于持续诱导模型自己去找东西装 —— 与产品「先批准再动手」的调性相反，
 * 而且是把它没有的主动权塞给它。所以这段提示只在意图明确时出现。
 *
 * 反例（必须**不**触发，见测试）：`你有哪些技能`、`用你的技能分析订单` ——
 * 它们提到"技能"但都不是安装意图。
 */
const INSTALL_INTENT_PATTERNS: readonly RegExp[] = [
  // 中文：动词 + 技能（允许中间插"一个/个/新"）
  /(装|安装|添加|新增|下载|导入|接入)(一个|个|新)?[^。！？\n]{0,6}技能/,
  /(找|搜|搜索|物色|推荐|看看)(一个|个|些|有没有)?[^。！？\n]{0,12}技能/,
  // 「有没有…技能」是中文里最常见的求助句式。注意不能写成 /有哪些.*技能/ ——
  // "你有哪些技能"是清点，不是安装意图，它在防误报用例里。
  /有没有[^。！？\n]{0,12}技能/,
  /技能(库|市场|商店|仓库)/,
  // English
  /\b(install|add|import|download|fetch)\b[^.\n]{0,24}\bskills?\b/i,
  /\b(find|search|look\s+for|recommend|discover)\b[^.\n]{0,24}\bskills?\b/i,
  /\bskill\s+(marketplace|library|store|repo)\b/i,
  // Español
  /\b(instalar|añadir|agregar|buscar|encontrar)\b[^.\n]{0,24}\bhabilidad/i,
];

/** 这句话是不是在要求"找一个 / 装一个"技能？ */
export function hasInstallIntent(message: string): boolean {
  const text = (message ?? '').trim();
  if (text.length === 0) return false;
  return INSTALL_INTENT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * 安装意图明确时给出的操作说明。**不含**任何"你可以自己去找"的鼓励 —— 只说明
 * 已经有了哪两个动作，以及高影响会挂起等人批。
 */
export function installIntentHint(message: string, locale: string): string {
  if (!hasInstallIntent(message)) return '';
  if (locale === 'zh') {
    return [
      '用户想获取/安装技能。运行时已具备两个动作：',
      '1) skill_manage(action="fetch", source="owner/repo 或 https://…") 取回到隔离区（只落地，未生效）；',
      '2) skill_manage(action="install", source="<fetch 返回的路径>") 安装。',
      '只申请只读类能力的技能会直接装好；申请高影响能力（写文件 / 执行命令 / 联网 / 读环境变量 / 控制进程）的技能会**挂起等待人工批准**，此时告知用户去 /skills pending 审批，不要重复尝试。',
      '不要凭记忆编造技能内容；也不要在用户没有要求时主动去联网找技能。',
    ].join('\n');
  }
  return [
    'The user wants to obtain/install a skill. Two actions are available:',
    '1) skill_manage(action="fetch", source="owner/repo or https://…") to clone into quarantine (inert, not installed);',
    '2) skill_manage(action="install", source="<path returned by fetch>") to install it.',
    'A skill asking only for read-level capabilities installs directly; one asking for a high-impact capability (file writes / shell / network / env secrets / process control) is **staged for human approval** — tell the user to review /skills pending and do not retry.',
    'Do not invent skill content, and do not go looking for skills online unless the user asked.',
  ].join('\n');
}
