/**
 * 审批卡片载荷 —— 把 `agent_approvals` 行转成「能在聊天里安全展示」的结构。
 *
 * 安全约束：`payload` / `arguments` 可能含退款金额、客户名单、工具参数，
 * 绝对不能整个丢给前端。这里只保留**标量字段**并脱敏键名，
 * 嵌套结构一律丢弃（需要细节的人去审批中心看）。
 */

import { canApprove, type ApprovalRisk, type ApprovalRole } from '@/lib/agent/approvals';
import type { RoleKey } from '@/lib/rbac';
import type { ApprovalCardPayload } from '@/lib/agent/stream-events';

const SENSITIVE_KEY = /(key|token|secret|password|credential|authorization|cookie|signature|hash)/i;
const MAX_SUMMARY_FIELDS = 12;
const MAX_STRING = 160;

export interface ApprovalRow {
  id: string;
  action_type: string;
  title: string;
  description: string | null;
  risk_level: string;
  required_role: string;
  status: string;
  payload: unknown;
  created_at: string;
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean';
}

/** 从任意嵌套对象里取出可安全展示的标量摘要（一层，最多 12 个字段） */
export function summarizeApprovalPayload(payload: unknown): Record<string, string | number | boolean | null> {
  const summary: Record<string, string | number | boolean | null> = {};
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return summary;

  const entries = Object.entries(payload as Record<string, unknown>);
  for (const [key, value] of entries) {
    if (Object.keys(summary).length >= MAX_SUMMARY_FIELDS) break;
    if (SENSITIVE_KEY.test(key)) {
      summary[key] = '[redacted]';
      continue;
    }
    if (isScalar(value)) {
      summary[key] = typeof value === 'string' && value.length > MAX_STRING
        ? `${value.slice(0, MAX_STRING)}…`
        : value;
      continue;
    }
    if (Array.isArray(value)) {
      // 数组只报长度，不展开内容（客户名单这类不能进聊天记录）
      summary[`${key}_count`] = value.length;
      continue;
    }
    // 嵌套对象不展开，避免把内部结构暴露到前端
  }
  return summary;
}

const RISKS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'critical']);
const ROLES: ReadonlySet<string> = new Set(['manager', 'owner', 'admin']);

/** 行 → 卡片载荷；非法行返回 null（调用方跳过，不阻塞主流程） */
export function toApprovalCard(row: ApprovalRow, viewerRole: RoleKey): ApprovalCardPayload | null {
  if (!row?.id || !row.title) return null;
  const riskLevel = RISKS.has(row.risk_level) ? row.risk_level : 'medium';
  const requiredRole = ROLES.has(row.required_role) ? row.required_role : 'manager';
  return {
    id: row.id,
    actionType: row.action_type,
    title: row.title,
    description: row.description ?? null,
    riskLevel,
    requiredRole,
    status: row.status,
    createdAt: row.created_at,
    canDecide: canApprove(viewerRole, requiredRole as ApprovalRole),
    summary: summarizeApprovalPayload(row.payload),
  };
}

/** 风险等级 → UI 配色键（未知值按 medium 处理） */
export function riskTone(riskLevel: string): ApprovalRisk {
  return (RISKS.has(riskLevel) ? riskLevel : 'medium') as ApprovalRisk;
}
