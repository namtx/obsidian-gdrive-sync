Status: resolved
Type: task
Blocked by: 03

# Core: per-file manifest commits and resumable runs

Execute a plan file by file, committing the manifest only after each file succeeds, so a failed run leaves a consistent manifest and a retry resumes safely. Retry policy hooks for backoff.

Done when: tests inject a failure mid-plan and a second run finishes without duplicates or losses.

Spec: ../spec.md

## Answer

SyncEngine runs moves, then actions, one at a time, each wrapped in the retry hook (options.retry). The manifest is committed via options.commit after each success. A failure is logged, the run continues, and the status is partial. The Drive cursor only advances when every action succeeded, so a retry replays the same remote changes; since the plan is state-based, replaying is safe. Upload-then-crash leaves the next run with matching hashes → record, not a duplicate. Tests: tests/core-resilience.test.ts. HTTP-level backoff (429/5xx) belongs in ticket 10's retry policy.
