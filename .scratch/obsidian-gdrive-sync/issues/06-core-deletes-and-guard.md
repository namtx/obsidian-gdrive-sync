Status: resolved
Type: task
Blocked by: 03

# Core: delete propagation and mass-delete guard

Propagate deletes to Drive trash. Plans that delete more than 20% of the vault or more than 50 files are flagged as requiring confirmation and do not execute until confirmed.

Done when: tests cover single delete, delete-vs-edit conflict, and guard trigger and bypass.

Spec: ../spec.md

## Answer

Delete actions from plan.ts; deleteRemote uses RemoteStore.trash. Guard in SyncEngine.sync: more than 20% of max(manifest, local) files or more than 50 deletes returns status needsConfirmation/massDelete with the plan summary and changes nothing; confirmDeletes: true proceeds. Delete-vs-edit always keeps the edit (restores or re-uploads). Thresholds are configurable via deleteGuard. Tests: tests/core-deletes.test.ts.
