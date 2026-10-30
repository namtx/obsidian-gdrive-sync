Status: resolved
Type: task
Blocked by: 03

# Core: rename detection

Detect renames via vault rename events first, content-hash matching as fallback. Apply by Drive file ID without re-upload.

Done when: tests cover event rename, hash-matched rename, and ambiguous duplicate content.

Spec: ../spec.md

## Answer

src/core/renames.ts: collapseRenames (event chains), detectRenames. Local renames: vault events first, then a unique content-hash match (ambiguous duplicates fall through to delete + create). Remote renames are detected by Drive file id. Moves run before the plan, move the merge base too, and never re-upload. Tests: tests/core-renames.test.ts. Ticket 13 needs to queue vault rename events persistently between syncs and clear them after a sync.
