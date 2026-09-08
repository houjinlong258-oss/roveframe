export type PluginType = 'business_feature' | 'ui_extension' | 'workflow_addon' | 'integration';

export type PluginPermission =
  | 'orders.read'
  | 'orders.write'
  | 'customers.read'
  | 'customers.write'
  | 'products.read'
  | 'products.write'
  | 'inventory.read'
  | 'reviews.read'
  | 'reviews.write'
  | 'marketing.write';

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  type: PluginType;
  description: string;
  permissions: PluginPermission[];
  files: string[];
  entry?: string;
  config?: Record<string, unknown>;
}

export interface RegisteredPlugin {
  manifest: PluginManifest;
  enabled: boolean;
  registeredAt: string;
}
