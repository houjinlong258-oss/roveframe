import { PluginManifest, PluginPermission, RegisteredPlugin } from './types';
import { validatePluginManifest } from './validator';

class PluginRegistry {
  private plugins = new Map<string, RegisteredPlugin>();

  /** Register a new plugin from a plugin.json manifest object. */
  public registerPlugin(manifest: PluginManifest): { success: boolean; errors?: string[] } {
    const validation = validatePluginManifest(manifest);
    if (!validation.valid) {
      return { success: false, errors: validation.errors };
    }

    if (this.plugins.has(manifest.id)) {
      return { success: false, errors: [`Plugin with id "${manifest.id}" is already registered.`] };
    }

    const registered: RegisteredPlugin = {
      manifest,
      enabled: true,
      registeredAt: new Date().toISOString(),
    };

    this.plugins.set(manifest.id, registered);
    return { success: true };
  }

  /** Get a registered plugin by ID. */
  public getPlugin(id: string): RegisteredPlugin | undefined {
    return this.plugins.get(id);
  }

  /** List all registered plugins. */
  public listPlugins(): RegisteredPlugin[] {
    return Array.from(this.plugins.values());
  }

  /** Check if a plugin has a specific permission. */
  public hasPermission(pluginId: string, permission: PluginPermission): boolean {
    const plugin = this.plugins.get(pluginId);
    if (!plugin || !plugin.enabled) return false;
    return plugin.manifest.permissions.includes(permission);
  }

  /** Find all plugins that possess a specific permission. */
  public findByPermission(permission: PluginPermission): RegisteredPlugin[] {
    return Array.from(this.plugins.values()).filter(
      (p) => p.enabled && p.manifest.permissions.includes(permission)
    );
  }

  /** Enable or disable a plugin safely. */
  public setPluginStatus(id: string, enabled: boolean): boolean {
    const plugin = this.plugins.get(id);
    if (!plugin) return false;
    plugin.enabled = enabled;
    return true;
  }

  /** Clear all registered plugins (primarily for unit tests). */
  public clear(): void {
    this.plugins.clear();
  }
}

export const pluginRegistry = new PluginRegistry();
