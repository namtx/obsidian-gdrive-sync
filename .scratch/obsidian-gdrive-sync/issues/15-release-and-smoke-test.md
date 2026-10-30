Status: open
Type: task
Blocked by: 14

# Release via BRAT and two-device smoke test

Publish a GitHub release with `main.js`, `manifest.json`, `styles.css`. Install on Mac and iPhone through BRAT (manual copy as fallback). Run the manual smoke test: edit on each device, conflict on both, rename, delete, mass-delete guard, large file, offline then reconnect.

Done when: the checklist passes on both devices and results are appended under `## Comments`.

Spec: ../spec.md

## Comments

2026-10-30: BRAT releases 0.1.0 and 0.2.0 published; both devices did a first sync successfully. Remaining smoke-test checklist (carried from tickets 13 and 14):
- iPhone: resume trigger (background over 1 min, then return), interval trigger, edit trigger (sync about 10 s after an edit)
- Edit the same note on both devices offline, then sync: clean merge and overlapping keep-both copy
- Rename and move a note on one device: arrives as a move on the other
- Delete more than 20% of the vault or over 50 files: mass-delete dialog appears; Cancel pauses; confirm deletes to trash
- Attachment over the size cap is listed as skipped
