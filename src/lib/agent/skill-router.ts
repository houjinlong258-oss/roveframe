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
