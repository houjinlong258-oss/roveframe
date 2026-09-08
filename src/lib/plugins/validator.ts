import { PluginManifest, PluginPermission } from './types';

const ALLOWED_PERMISSIONS: Set<PluginPermission> = new Set([
  'orders.read',
  'orders.write',
  'customers.read',
  'customers.write',
  'products.read',
  'products.write',
  'inventory.read',
  'reviews.read',
  'reviews.write',
  'marketing.write',
]);

const FORBIDDEN_FILE_PATTERNS = [
  /^src\/core\//,
  /^src\/app\/api\/auth\//,
  /^src\/app\/api\/payment\//,
  /^src\/storage\/database\//,
  /^\.\./,
];

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validatePluginManifest(manifest: unknown): ValidationResult {
  const errors: string[] = [];

  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['Manifest must be a non-null object'] };
  }

  const obj = manifest as Record<string, unknown>;

  if (typeof obj.id !== 'string' || !obj.id.trim()) errors.push('Plugin manifest missing valid string field "id"');
  if (typeof obj.name !== 'string' || !obj.name.trim()) errors.push('Plugin manifest missing valid string field "name"');
  if (typeof obj.version !== 'string' || !obj.version.trim()) errors.push('Plugin manifest missing valid string field "version"');
  if (!['business_feature', 'ui_extension', 'workflow_addon', 'integration'].includes(obj.type as string)) {
    errors.push('Plugin manifest "type" must be one of: business_feature, ui_extension, workflow_addon, integration');
  }

  if (!Array.isArray(obj.permissions)) {
    errors.push('Plugin manifest "permissions" must be an array');
  } else {
    for (const perm of obj.permissions) {
      if (!ALLOWED_PERMISSIONS.has(perm as PluginPermission)) {
        errors.push(`Invalid or disallowed permission "${String(perm)}" requested by plugin`);
      }
    }
  }

  if (!Array.isArray(obj.files)) {
    errors.push('Plugin manifest "files" must be an array of file patterns');
  } else {
    for (const filePattern of obj.files) {
      if (typeof filePattern !== 'string') {
        errors.push('Plugin file entries must be strings');
        continue;
      }
      for (const forbiddenPattern of FORBIDDEN_FILE_PATTERNS) {
        if (forbiddenPattern.test(filePattern)) {
          errors.push(`Plugin attempts to touch forbidden core path "${filePattern}"`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
