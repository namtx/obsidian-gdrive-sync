import type { VaultPath } from "../core/types";

export interface ScopeSettings {
  /** The vault's config folder, usually `.obsidian` (`Vault.configDir`). */
  configDir: string;
  /** This plugin's folder. Never synced: it holds tokens, the manifest and merge bases. */
  pluginDir: string;
  /** Sync the rest of the config folder (settings, themes, other plugins). */
  syncConfig: boolean;
}

/** Whether a vault path takes part in sync. */
export function inScope(path: VaultPath, s: ScopeSettings): boolean {
  const configPrefix = `${s.configDir}/`;
  if (path.startsWith(configPrefix)) {
    if (!s.syncConfig) return false;
    if (path === s.pluginDir || path.startsWith(`${s.pluginDir}/`)) return false;
    // Open panes and layouts differ per device.
    if (/^workspace[^/]*\.json$/.test(path.slice(configPrefix.length))) return false;
    return !hasHiddenSegment(path.slice(configPrefix.length));
  }
  // `.trash`, `.git`, `.DS_Store` and other dotfiles anywhere in the vault.
  return !hasHiddenSegment(path);
}

function hasHiddenSegment(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith("."));
}
