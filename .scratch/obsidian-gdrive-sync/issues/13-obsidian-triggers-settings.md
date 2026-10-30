Status: claimed
Type: task
Blocked by: 07, 08, 11, 12

# Obsidian: triggers, commands and settings tab

Wire the engine to Obsidian: sync on app open, manual command and ribbon button, foreground interval (default 5 min, configurable), debounced sync after local edit. Settings tab for interval, size cap, `.obsidian` sync toggle and sign-in.

Done when: all four triggers work on desktop and iOS, and overlapping syncs are prevented.

Spec: ../spec.md

## Comments

2026-10-30: Implemented.
- src/obsidian/sync-controller.ts: `SyncController` runs one sync at a time; triggers arriving mid-sync collapse into one follow-up, and a manual trigger outranks a queued automatic one. Edits are debounced (10 s). `SelfWriteFilter` marks paths the sync itself wrote for 5 s, so those vault events don't retrigger. `ThrottledSaver` saves the manifest at most every 2 s, plus a final flush.
- src/obsidian/sync-runner.ts: builds the engine (SelfWriteFilter(ObsidianLocalStore), DriveRemoteStore at ObsidianSync/<vault name>, AdapterBaseStore), keeps the manifest in `<pluginDir>/sync-state.json` (not data.json), passes the rename journal and consumes it after a clean sync, maps results to notices (always for manual and partial; AuthExpiredError gets a sticky notice). Keeps `last` (trigger, result, error, timing) for ticket 14.
- main.ts triggers: startup (onLayoutReady; vault event listeners also registered only then, because "create" fires for every file during load), resume (visibilitychange to visible, more than 60 s after the last sync), manual (command + ribbon), interval (checked every 30 s, only while visible, setting in minutes, 0 = off), edit (vault create/modify/delete/rename, in scope and not self-written).
- Settings: Sync now, device name (default Mac/iPhone/iPad/Android/Desktop), interval, max file size MB, config-folder toggle.
- Tests: tests/sync-controller.test.ts (overlap collapse, failure recovery, debounce, self-write window, throttled saver).
- Verified live on macOS (obsidian-cli + CDP): startup ran the full pipeline and stopped at first-sync confirmation (2 uploads planned, nothing written); 4 concurrent triggers → 2 sequential runs, max 1 active; edit debounce fired once after the quiet period; interval fired.
- Remaining before resolve: the resume trigger (not simulated) and all triggers on iOS. Needs a new BRAT release; best done after ticket 14, since first sync needs the confirmation dialog.
