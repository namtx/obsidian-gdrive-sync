Status: resolved
Type: task
Blocked by: 03

# Core: three-way merge and keep-both conflicts

Both sides changed: three-way text merge for Markdown using the last-synced copy as base. If not clean, keep both as `note (conflict <device> <date>).md`. Binaries: last-writer-wins by modified time. Never silently drop edits.

Done when: tests cover clean merge, overlapping edit, binary conflict, and no-base conflict.

Spec: ../spec.md

## Answer

src/core/merge.ts (line-based diff3 via node-diff3, conflictPath naming), conflict handling in src/core/engine.ts. The merge base is the last-synced copy, kept on the device in a BaseStore (src/core/base.ts) for .md/.txt only, and checked against the manifest hash before use. Drive revisions expire, so the base can't live there. Missing or stale base, or an overlapping edit: keep both. This device's version goes to `note (conflict <device> <YYYY-MM-DD>).md` and the remote version keeps the path. Binaries with a base: last writer wins by mtime. If remote wins, the local loser is kept as a conflict copy (Drive keeps no copy of it); if local wins, the remote loser stays in Drive revision history. Every write re-checks that the local file hasn't changed since the scan. Tests: tests/core-merge.test.ts. Follow-up for ticket 12: the obsidian layer needs a file-backed BaseStore outside the synced vault area.
