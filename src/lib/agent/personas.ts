/**
 * RoveFrame Executive Layer personas —— 统一 RoveAgent Runtime，
 * 以 persona/skills/permissions/workflows 区分（不新建 runtime）。
 */
export type PersonaKey = 'ceo-insight' | 'coo' | 'cmo' | 'cto';

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
];

const PERSONA_KEYS: ReadonlySet<string> = new Set(PERSONAS.map((p) => p.key));

/** 校验并归一化客户端传入的 persona key（缺省 CEO Insight）。 */
export function resolvePersonaKey(value: unknown): PersonaKey {
  if (typeof value === 'string' && PERSONA_KEYS.has(value)) return value as PersonaKey;
  return 'ceo-insight';
}
