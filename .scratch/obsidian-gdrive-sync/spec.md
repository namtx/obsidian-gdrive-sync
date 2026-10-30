# Spec: Obsidian ↔ Google Drive sync plugin

Status: draft (design agreed via grilling session, 2026-10-30)

## Goal

Keep one Obsidian vault in sync between macOS and iPhone, using Google Drive as the transport. No third-party service. Delivered as a custom Obsidian plugin, since a plugin is the only code that can run on iOS.

## Decisions

### Platform and delivery
- Custom plugin in TypeScript, standard Obsidian plugin template, esbuild.
- Networking via Obsidian `requestUrl` calling the Drive REST API directly. No Node-only modules, so it runs on iOS.
- Install on iPhone via private BRAT install from a GitHub release. Fall back to manual copy of `main.js`, `manifest.json`, `styles.css` into `.obsidian/plugins/`. No community store for now.
- iOS has no background execution: iOS syncs only while Obsidian is open.

### Triggers
- On app open, manual command and ribbon button, foreground interval (default 5 min, configurable), and debounced after local edit.

### Scope
- Vault: mostly Markdown, under ~1 GB, a few thousand files. Notes and attachments sync.
- Always excluded: `.obsidian/workspace*.json`, `.trash`.
- Rest of `.obsidian/`: optional, default off, in three toggles: community plugins (code, settings, enabled list; applied live by enabling, disabling or reloading plugins, desktop-only plugins skipped on mobile), Obsidian settings, and themes/snippets (applied on reload). This plugin's own folder never syncs. (Added 2026-10-30, ticket 16.)
- Files over a configurable size (default 50 MB) are skipped and listed in status.
- Out of scope for v1: multiple vaults per install, selective folder sync, sharing with other people, Android/Windows testing (should still work).

### Drive layout and auth
- Scope `drive.file`. Visible folder `ObsidianSync/<vault>/` mirroring the vault tree. The app only sees files it created.
- OAuth with PKCE, Google **Web application** client created by the user in their own Cloud project, system browser for consent. Google rejects `obsidian://` redirect URIs, so Google redirects to a static page on GitHub Pages (`https://namtx.dev/obsidian-gdrive-sync/oauth.html`) that forwards `code`/`state` to `obsidian://gdrive-sync-auth`. The client secret is entered per device and stored with the tokens. (Changed 2026-10-30 during ticket 09.)
- OAuth app set to "In production" (unverified, personal use) to avoid the 7-day refresh-token expiry of Testing mode.
- Refresh token stored in plugin `data.json`, never synced.
- Personal Gmail account.

### Sync engine
- Per-device manifest: path, SHA-256 content hash, Drive file ID, last-synced revision.
- Change detection with the Drive Changes API and a stored page token, so a sync transfers deltas only. Hash content; do not trust modified times (unreliable on iOS).
- Renames: use vault rename events first, hash matching as fallback. Applied by Drive file ID, no re-upload.
- Conflicts: three-way merge for Markdown using the last-synced copy as base. If not clean, keep both (`note (conflict <device> <date>).md`). Binaries: last-writer-wins by modified time. Never silently drop edits.
- Deletes: propagate to Drive trash (recoverable 30 days). Mass-delete guard: a sync that would delete more than 20% of the vault or 50 files pauses for confirmation.
- First sync: reconcile local vs Drive by hash. Identical files are recorded with no transfer, one-sided files are copied, differing files with no base become keep-both conflicts. A dry-run summary (uploads, downloads, conflicts) must be confirmed before the first real sync.
- Resilience: resumable uploads for large files, exponential backoff on 429/5xx, manifest committed per file only after that file succeeds, so retries resume safely.
- Visibility: status bar indicator and a viewable log of the last sync's actions and errors.

### Encryption
- Plain files in Drive for v1. Structure the code so optional passphrase encryption can be added later.

## Architecture

- `core/`: pure sync engine (diff, plan, merge, manifest). No Obsidian or Drive imports. Takes interfaces `LocalStore` and `RemoteStore`.
- `drive/`: `RemoteStore` implementation over the Drive API, plus OAuth.
- `obsidian/`: `LocalStore` implementation over the Vault API, settings tab, commands, status bar, log view.

## Testing
- Vitest unit tests for `core/` against in-memory fake stores: conflicts, renames, deletes and the delete guard, first-sync reconciliation, partial-failure resume.
- Manual two-device smoke test (Mac + iPhone) for the Obsidian and Drive integration layer.

## Open items (not blocking)
- Real vault size and file count to confirm the Q4 assumptions.
- Obsidian is not yet installed on this machine.
