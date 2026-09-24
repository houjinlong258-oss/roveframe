/**
 * RoveFrame Executive Layer personas —— 统一 RoveAgent Runtime，
 * 以 persona/skills/permissions/workflows 区分（不新建 runtime）。
 *
 * `employeeKey` 必须对应运行时 `roveagent/api/capability_router.py` 里
 * AGENT_CAPABILITIES 的一个 key —— 否则界面选得中、运行时给不出对应工具集。
 * 这条一致性由 tests/persona-runtime-parity.test.ts 锁定。
 */
export type PersonaKey = 'ceo-insight' | 'coo' | 'cmo' | 'cto' | 'developer';

export interface Persona {
  key: PersonaKey;
  label: string;
  description: string;
  employeeKey: string;
}

export const PERSONAS: Persona[] = [
  {
    key: 'ceo-insight',
    label: 'CEO Insight',
    description: 'Business overview & strategy',
    employeeKey: 'ceo',
  },
  {
    key: 'coo',
    label: 'COO',
    description: 'Operations',
    employeeKey: 'operations',
  },
  {
    key: 'cmo',
    label: 'CMO',
    description: 'Customer growth',
    employeeKey: 'marketing',
  },
  {
    key: 'cto',
    label: 'CTO',
    description: 'System health',
    employeeKey: 'devops',
  },
  /**
   * 研发 Agent。**这个入口此前缺失，是一个真实的能力黑洞。**
   *
   * 运行时里 `developer` 一直存在且工具集最全：
   *   toolsets=("file","terminal","todo","git","skills","delegation")
   *   summary="AI 软件工程师：读写代码、打补丁、跑测试、git 提交（写与提交需审批）"
   * 但前端只有 4 个 persona（ceo / operations / marketing / devops），**没有任何一个
   * 映射到 `developer`** —— 这个编码 agent 从界面上永远够不到。
   *
   * 用户反馈「这个不能编码啊」时，答话的是 CEO Agent，原话
   * "I don't have access to a terminal or file system"。而 CEO 的能力画像里
   * 本就写着「不碰文件与终端」—— 它没说错，是**用户根本没有可选的编码角色**。
   */
  {
    key: 'developer',
    label: 'Developer',
    description: 'Code, patch, test & ship',
    employeeKey: 'developer',
  },
];

const PERSONA_KEYS: ReadonlySet<string> = new Set(PERSONAS.map((p) => p.key));

/** 校验并归一化客户端传入的 persona key（缺省 CEO Insight）。 */
export function resolvePersonaKey(value: unknown): PersonaKey {
  if (typeof value === 'string' && PERSONA_KEYS.has(value)) return value as PersonaKey;
  return 'ceo-insight';
}
