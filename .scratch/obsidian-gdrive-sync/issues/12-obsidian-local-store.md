Status: open
Type: task
Blocked by: 02

# Obsidian: LocalStore over the Vault API

Implement `LocalStore` using the Vault API. Always exclude `.obsidian/workspace*.json` and `.trash`. Rest of `.obsidian/` behind an off-by-default setting. Skip files over the size cap (default 50 MB) and list them.

Done when: exclusions and size cap are covered by tests, and rename events are surfaced to the engine.

Spec: ../spec.md
