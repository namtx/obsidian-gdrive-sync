Status: resolved
Type: task
Blocked by: 10

# Drive: delta detection via Changes API

Use the Changes API with a stored page token so a sync transfers deltas only. Handle token invalidation by falling back to a full listing.

Done when: a second sync with no changes makes no per-file calls, and changes from the other device are picked up.

Spec: ../spec.md

## Answer

DriveRemoteStore.changesSince: paginated changes.list from the stored page token, newStartPageToken as the next cursor; 400/404 (invalid token) returns null and the engine falls back to listAll. Folder renames, moves or trashes also return null, because Drive reports only the folder, not its descendants. listAll takes the start token before listing, so nothing is missed. Verified live (tests/sync-live.test.ts, two simulated devices on real Drive): a sync with no changes makes exactly one request (GET /changes); edits, renames and deletes from the other device are picked up; concurrent non-overlapping edits merge on both devices.
