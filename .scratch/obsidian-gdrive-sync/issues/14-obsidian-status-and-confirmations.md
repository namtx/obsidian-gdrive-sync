Status: resolved
Type: task
Blocked by: 13

# Obsidian: status bar, log view and confirmation dialogs

Status bar indicator, viewable log of the last sync's actions and errors, a dry-run confirmation dialog for the first sync, and a confirmation dialog for the mass-delete guard.

Done when: first sync cannot proceed without confirming the dry-run, and a guarded plan waits for confirmation.

Spec: ../spec.md

## Comments

2026-10-30: Implemented.
- src/obsidian/ui.ts `ConfirmSyncModal`: title, explanation, collapsible per-section path lists (capped at 200 shown). Esc/X counts as cancel. `SyncLogModal`: time, trigger, status, duration, error, failures with details, plan sections, actions.
- src/obsidian/status.ts: pure status text, relative time and summary sections (unit-tested in tests/obsidian-status.test.ts).
- Runner gate: on needsConfirmation it sets `paused` and opens the dialog once. Automatic triggers are skipped while paused; a manual sync re-plans and asks again. Confirming sets `nextOptions` (confirmFirstSync or confirmDeletes) for the next run only, then triggers it.
- Status bar (desktop only; mobile has none): signed out / syncing / not synced yet / confirm first sync / confirm deletes / N not synced / sync failed / synced X ago (+skipped). Refreshes every 30 s; click opens the log. "Show last sync log" command for mobile.
- Verified live on macOS: after reload, the startup sync opened "Confirm first sync" listing "Upload to Drive: 2" with both files; Cancel closed it, paused; an interval trigger was skipped; status bar "Drive: confirm first sync"; the log modal renders.
- Remaining: the user confirms the real first sync; the mass-delete dialog live (engine guard is unit-tested, same dialog path); iOS check with the next BRAT release.

## Answer

Shipped in 0.2.0. First sync cannot proceed without the dialog: verified live (startup opened "Confirm first sync", Cancel paused auto syncs, confirming ran the sync on both devices). A guarded plan waits for confirmation: engine-tested, same dialog path. Live mass-delete dialog moves to ticket 15 smoke test.
