import type { LogEntry } from "../core/engine";
import type { VaultPath } from "../core/types";

/** Parts of the config folder that can be synced, each with its own toggle. */
export interface ConfigSync {
  /** Installed community plugins (code and settings) and the enabled-plugins list. */
  plugins: boolean;
  /** Obsidian's own settings: app, appearance, hotkeys, core plugins and their options. */
  settings: boolean;
  /** Themes and CSS snippets. */
  themes: boolean;
}

export const NO_CONFIG_SYNC: ConfigSync = { plugins: false, settings: false, themes: false };

export interface ScopeSettings {
  /** The vault's config folder, usually `.obsidian` (`Vault.configDir`). */
  configDir: string;
  /** This plugin's folder. Never synced: it holds tokens, the manifest and merge bases. */
  pluginDir: string;
  config: ConfigSync;
}

export type ConfigCategory = keyof ConfigSync;

/** Which toggle covers a config-folder path, or null for paths that never sync. */
export function configCategory(path: VaultPath, s: Pick<ScopeSettings, "configDir" | "pluginDir">): ConfigCategory | null {
  const rest = path.slice(s.configDir.length + 1);
  if (path === s.pluginDir || path.startsWith(`${s.pluginDir}/`)) return null;
  if (hasHiddenSegment(rest)) return null;
  // Open panes and layouts differ per device.
  if (/^workspace[^/]*\.json$/.test(rest)) return null;
  if (rest === "community-plugins.json" || rest.startsWith("plugins/")) return "plugins";
  if (rest.startsWith("themes/") || rest.startsWith("snippets/")) return "themes";
  return "settings";
}

/** Whether a vault path takes part in sync. */
export function inScope(path: VaultPath, s: ScopeSettings): boolean {
  if (path.startsWith(`${s.configDir}/`)) {
    const category = configCategory(path, s);
    return category !== null && s.config[category];
  }
  // `.trash`, `.git`, `.DS_Store` and other dotfiles anywhere in the vault.
  return !hasHiddenSegment(path);
}

function hasHiddenSegment(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith("."));
}

/** Config changes a sync made on this device, so they can be applied without a restart. */
export interface ConfigChanges {
  /** Community plugins whose files changed here (code, manifest, styles or data.json). */
  plugins: Set<string>;
  /** Only data.json changed for these plugins. */
  pluginDataOnly: Set<string>;
  enabledList: boolean;
  settings: boolean;
  themes: boolean;
}

/** Actions that change local files. Uploads and records leave this device untouched. */
const LOCAL_WRITES = new Set(["download", "deleteLocal", "moveLocal", "conflict"]);

export function configChanges(log: LogEntry[], s: Pick<ScopeSettings, "configDir" | "pluginDir">): ConfigChanges {
  const out: ConfigChanges = { plugins: new Set(), pluginDataOnly: new Set(), enabledList: false, settings: false, themes: false };
  const codeChanged = new Set<string>();
  const prefix = `${s.configDir}/`;
  for (const e of log) {
    if (!e.ok || !LOCAL_WRITES.has(e.action)) continue;
    const from = e.action === "moveLocal" && e.detail?.startsWith("from ") ? [e.detail.slice(5)] : [];
    for (const path of [e.path, ...from]) {
      if (!path.startsWith(prefix)) continue;
      const category = configCategory(path, s);
      if (category === "settings") out.settings = true;
      else if (category === "themes") out.themes = true;
      else if (category === "plugins") {
        const rest = path.slice(prefix.length);
        if (rest === "community-plugins.json") {
          out.enabledList = true;
          continue;
        }
        const [, id, file] = rest.split("/");
        if (!id) continue;
        out.plugins.add(id);
        if (file !== "data.json" || rest.split("/").length > 3) codeChanged.add(id);
      }
    }
  }
  for (const id of out.plugins) if (!codeChanged.has(id)) out.pluginDataOnly.add(id);
  return out;
}
