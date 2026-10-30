Status: resolved
Type: task
Blocked by: 12, 13

# Obsidian: plugin sync and per-category config toggles

Sync community plugins between devices and apply them without a restart. Split the single config-folder toggle into categories.

Done when: plugin files and the enabled list sync, and a synced change enables, reloads or disables the plugin on the receiving device.

Spec: ../spec.md

## Answer

- src/obsidian/scope.ts: `configCategory` sorts config paths into plugins (`plugins/**`, `community-plugins.json`), themes (`themes/**`, `snippets/**`) and settings (everything else). Workspace files, dotfiles and this plugin's folder never sync. `ConfigSync` holds three toggles, all off by default; 0.2.0's `syncConfig` migrates to all three on or off.
- `configChanges(log)`: from local-writing actions (download, deleteLocal, moveLocal, conflict), collects changed plugin ids (data.json-only separately), enabled-list, settings and theme changes.
- src/obsidian/config-apply.ts: via Obsidian's internal plugin manager (`app.plugins`, the same calls BRAT uses): loadManifests; disable plugins dropped from the synced list; enable newly listed ones, skipping desktop-only plugins on mobile; reload enabled plugins whose files changed (or call `onExternalSettingsChange` when only data.json changed). It updates the in-memory `enabledPlugins` without saving, since the synced list is already on disk and a stale set would be written back by Obsidian's next save. Skipped in restricted mode. Never touches this plugin. Settings and theme changes show a "reload Obsidian" notice.
- The vault "raw" event now triggers a debounced sync for in-scope config-folder changes made on this device (e.g. enabling a plugin).
- Tests: categories, configChanges, two-device plugin sync excluding tokens (tests/obsidian-scope.test.ts). Live on macOS with a throwaway plugin: enable (load v1), reload after a code change (unload, load v2), disable when dropped from the list; own plugin untouched; user config restored.

## Comments

2026-10-30: Bug found before first use. On the first plugin sync both devices have a community-plugins.json with no shared base, which became a keep-both conflict: the remote list took the path and the receiving device could get its plugins disabled. Fixed in 0.3.1 with an engine `customMerge` hook (also stores bases for matching paths) and `mergeStringSet`: union without a base, three-way additions and removals with one. Tests in tests/core-merge.test.ts.

2026-10-30: Bug found live. A device that synced while a config toggle was off skipped the out-of-scope changes and moved its cursor past them. After the toggle was turned on, it never saw those remote files, and uploaded its own community-plugins.json as a second file at the same path. Fix: the runner keeps the scope key (config toggles + size cap) of the last clean sync; when it differs, the engine does a full listing (`fullListing`). Tests in tests/obsidian-scope.test.ts. The orphan duplicate was trashed in Drive.
