Status: resolved
Type: task
Blocked by: 02

# Obsidian: LocalStore over the Vault API

Implement `LocalStore` using the Vault API. Always exclude `.obsidian/workspace*.json` and `.trash`. Rest of `.obsidian/` behind an off-by-default setting. Skip files over the size cap (default 50 MB) and list them.

Done when: exclusions and size cap are covered by tests, and rename events are surfaced to the engine.

Spec: ../spec.md

## Answer

- src/obsidian/local-store.ts `ObsidianLocalStore`: notes and attachments via the Vault API (`getFiles`, `createBinary`/`modifyBinary`, `vault.rename`, `vault.trash(file, true)`, with system trash falling back to `.trash` on iOS), so editors and the metadata cache update immediately. The config folder (invisible to the Vault API) goes through the adapter and is walked only when config sync is on. Renames use `Vault.rename`, not `FileManager.renameFile`: link rewrites arrive from the other device as content changes.
- src/obsidian/scope.ts `inScope`: always excludes `.trash`, dotfiles and dotfolders, `<configDir>/workspace*.json`, and this plugin's folder (tokens, manifest, merge bases). The rest of the config folder is opt-in (`syncConfig`, default off); respects a custom `configDir`.
- Engine: `include` replaced by `scope` + `maxFileSize`. Out-of-scope or oversized paths are dropped from the local view, the remote view and the manifest, so turning config sync off or a file growing past the cap never reads as a delete. Oversized paths are listed in `summary.skipped`.
- src/obsidian/rename-journal.ts: vault `rename` events (files only; folder renames fire per file) persisted in data.json `pendingRenames`. Ticket 13 should pass `snapshot()` to the engine and call `consumed(n)` after a clean sync. The store's own renames also land in the journal; they are harmless because the manifest already holds the new path.
- src/obsidian/base-store.ts: merge bases stored under `<pluginDir>/bases/<sha256(path)>`.
- Tests: tests/obsidian-scope.test.ts (scope rules, size cap, config toggle, journal). Smoke-tested live in the Mac vault via obsidian-cli: write/modify/list/rename/journal/trash, config listing, base store.
- Notes for ticket 13: keep the manifest in its own file in the plugin folder rather than data.json, and throttle commits (a lost commit is safe: the next run sees matching hashes and records them). Suppress edit-triggered syncs caused by the sync's own writes.
