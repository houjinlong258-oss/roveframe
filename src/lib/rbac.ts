/** 角色与权限（RBAC，P0 地基） */

export type RoleKey = 'owner' | 'manager' | 'staff';

export const ROLE_PERMISSIONS: Record<RoleKey, string[]> = {
  owner: ['*'],
  manager: [
    'orders:read', 'orders:write',
    'products:read', 'products:write',
    'customers:read',
    'customers:write',
    'reviews:read', 'reviews:write',
    'reservations:read', 'reservations:write',
    'channels:read', 'channels:write',
    'marketing:read', 'marketing:write',
    // Phase 16 任务 6：店长原本没有 marketing:send，于是"只有 owner 能发群发邮件"。
    // 实际经营里发活动邮件是店长的日常工作，owner 每天盯着发信不现实 ——
    // 结果是这个功能在真实门店里没人用。发信仍是**对外可见动作**，
    // 按任务 7 的口径必须经审批，因此放开给店长不会绕过审批。
    'marketing:send',
    'emails:read', 'emails:write',
    'knowledge:read', 'knowledge:write',
    'staff:read', 'staff:write',
    'inventory:read',
    'settings:read',
    'agent_actions:read',
    'notifications:read', 'notifications:write',
    'agent:use',
    'approvals:decide',
    'approvals:read',
    'audit:read',
    'coding:propose',
    'customization:write',
    'healing:write',
    // Phase 18：员工端与外卖的店长侧能力。
    // `delivery:dispatch` 与 `delivery:claim` 是**两个**权限，刻意不合并：
    // 认领是"我自己去送"，指派是"我让别人去送"，后者是管理动作。
    'workforce:self',
    'workforce:manage',
    // 关怀模块的独立权限，与 workforce:manage 刻意分开：
    // "能看排班与考勤"不等于"可以进员工关怀"。关怀记录另有一条**行级**规则
    // （只有作者与当事人能读内容，owner 的 '*' 也覆盖不了），
    // 而"能不能进这个模块"由这条权限决定。缺了它店长会拿到 403 ——
    // fail-closed，不是静默降级。
    'workforce:care',
    'delivery:claim',
    'delivery:dispatch',
    'reservations:confirm',
  ],
  staff: [
    'orders:read',
    'customers:read',
    'agent:use',
    'healing:write',
    /**
     * Phase 18：员工端需要的能力，一律用**窄权限**，不放开 orders:write。
     *
     * 为什么不直接给 staff `orders:write`：那等于"任何员工可改任意订单金额"。
     * 员工真正需要的只有两件事 —— 看菜单、推进自己接的那一单。
     * 所以给 products:read（只读）、delivery:claim（认领）、
     * reservations:confirm（确认预约）三个精确动作。
     *
     * 越权的第二道锁在接口里，不在权限矩阵里：外卖单只能动
     * `rider_staff_id = 会话解析出的 staff id` 的那些行，客户端传什么都不看。
     */
    'products:read',
    'workforce:self',
    'delivery:claim',
    'reservations:confirm',
  ],
};

/** 判断某角色是否有某操作的权限；权限用 'entity:read'/'entity:write' 表示，'*' 通配所有 */
export function hasPermission(role: RoleKey | string, action: string): boolean {
  const perms = ROLE_PERMISSIONS[role as RoleKey];
  if (!perms) return false;
  if (perms.includes('*')) return true;
  if (perms.includes(action)) return true;
  const [entity] = action.split(':');
  return perms.includes(`${entity}:*`);
}
