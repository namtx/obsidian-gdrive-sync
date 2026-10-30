Status: resolved
Type: task
Blocked by: 04, 05, 06

# Core: first-sync reconciliation and dry run

Reconcile a local vault against an existing Drive folder by hash: identical files recorded with no transfer, one-sided files copied, differing files with no base become keep-both conflicts. Produce a dry-run summary (uploads, downloads, conflicts) that must be confirmed before execution.

Done when: tests cover empty-remote, empty-local, identical, and divergent starts.

Spec: ../spec.md

## Answer

First sync (manifest.cursor === null) uses a full listing, skips rename detection, and returns needsConfirmation/firstSync with a summary (uploads, downloads, unchanged, conflicts) until confirmFirstSync: true. dryRun: true plans without changes. Identical files are recorded with no transfer; differing files with no base keep both. An expired cursor falls back to a full listing. Note: if the first sync is partial, the cursor stays null, so the next run asks for confirmation again, showing only the remaining work. Tests: tests/core-first-sync.test.ts.
