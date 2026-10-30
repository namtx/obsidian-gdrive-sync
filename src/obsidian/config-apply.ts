import { Notice, Platform, type App, type PluginManifest } from "obsidian";
import type { ConfigChanges } from "./scope";

/**
 * Obsidian's internal plugin manager. Not in the public API; the same calls
 * BRAT and hot-reload plugins rely on.
 */
interface PluginManager {
  manifests: Record<string, PluginManifest>;
  plugins: Record<string, { onExternalSettingsChange?: () => unknown }>;
  enabledPlugins: Set<string>;
  /** False in restricted mode (community plugins turned off). */
  isEnabled(): boolean;
  loadManifests(): Promise<void>;
  /** Loads without touching the saved enabled list. */
  enablePlugin(id: string): Promise<boolean>;
  /** Unloads without touching the saved enabled list. */
  disablePlugin(id: string): Promise<void>;
}

/**
 * Bring running plugins in line with config files a sync just wrote: enable or
 * disable per the synced list, reload plugins whose files changed. The synced
 * `community-plugins.json` is already on disk, so only the in-memory set is
 * updated; saving it would be redundant, and leaving it stale would let
 * Obsidian write the old list back on its next save.
 */
export async function applyConfigChanges(app: App, changes: ConfigChanges, ownId: string): Promise<string[]> {
  const pm = (app as unknown as { plugins: PluginManager }).plugins;
  const done: string[] = [];
  const pluginWork = changes.enabledList || changes.plugins.size > 0;

  if (pluginWork && pm.isEnabled()) {
    await pm.loadManifests();
    const runnable = (id: string) => {
      const m = pm.manifests[id];
      return !!m && id !== ownId && !(Platform.isMobile && m.isDesktopOnly);
    };

    if (changes.enabledList) {
      const listPath = `${app.vault.configDir}/community-plugins.json`;
      const wanted = new Set<string>(
        (await app.vault.adapter.exists(listPath)) ? (JSON.parse(await app.vault.adapter.read(listPath)) as string[]) : [],
      );
      for (const id of [...pm.enabledPlugins]) {
        if (id === ownId || wanted.has(id)) continue;
        await pm.disablePlugin(id);
        pm.enabledPlugins.delete(id);
        done.push(`disabled ${id}`);
      }
      for (const id of wanted) {
        if (pm.enabledPlugins.has(id) || !runnable(id)) continue;
        if (await pm.enablePlugin(id)) {
          pm.enabledPlugins.add(id);
          done.push(`enabled ${id}`);
        }
      }
    }

    for (const id of changes.plugins) {
      if (!pm.enabledPlugins.has(id) || !runnable(id) || done.includes(`enabled ${id}`)) continue;
      const instance = pm.plugins[id];
      if (changes.pluginDataOnly.has(id) && instance?.onExternalSettingsChange) {
        await instance.onExternalSettingsChange();
        done.push(`reloaded settings of ${id}`);
      } else {
        await pm.disablePlugin(id);
        await pm.enablePlugin(id);
        done.push(`reloaded ${id}`);
      }
    }
  }

  if (done.length) new Notice(`Google Drive Sync: plugins updated from another device: ${done.join(", ")}.`, 8_000);
  if (changes.settings || changes.themes)
    new Notice(
      "Google Drive Sync: Obsidian settings or themes changed on another device. Reload Obsidian to apply them " +
        "(command: Reload app without saving).",
      10_000,
    );
  return done;
}
