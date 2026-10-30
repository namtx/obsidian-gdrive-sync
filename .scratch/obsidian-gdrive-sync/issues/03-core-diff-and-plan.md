Status: resolved
Type: task
Blocked by: 02

# Core: hash-based diff and sync plan

Compute a sync plan from local state, remote state and manifest: upload, download, no-op. Use content hashes, never modified times.

Done when: tests cover create, update and unchanged on each side.

Spec: ../spec.md

## Answer

src/core/plan.ts: plan(local, remote, manifest) compares content hashes against the manifest base per path and returns upload / download / record / deleteRemote / deleteLocal / forget / conflict actions. Delete-vs-edit keeps the edit. Conflict resolution (04) and the delete guard (06) build on these actions. Tests: tests/core-plan.test.ts.
