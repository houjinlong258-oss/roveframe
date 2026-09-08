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
  ],
  staff: ['orders:read', 'customers:read', 'agent:use', 'healing:write'],
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
