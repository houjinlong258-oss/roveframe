/** 角色与权限（RBAC，P0 地基） */

export type RoleKey = 'owner' | 'manager' | 'staff';

export const ROLE_PERMISSIONS: Record<RoleKey, string[]> = {
  owner: ['*'],
  manager: [
    'orders:read', 'orders:write',
    'products:read', 'products:write',
    'customers:read',
    'reviews:read', 'reviews:write',
    'reservations:read', 'reservations:write',
  ],
  staff: ['orders:read', 'customers:read'],
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