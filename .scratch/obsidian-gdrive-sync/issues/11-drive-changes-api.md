Status: open
Type: task
Blocked by: 10

# Drive: delta detection via Changes API

Use the Changes API with a stored page token so a sync transfers deltas only. Handle token invalidation by falling back to a full listing.

Done when: a second sync with no changes makes no per-file calls, and changes from the other device are picked up.

Spec: ../spec.md
