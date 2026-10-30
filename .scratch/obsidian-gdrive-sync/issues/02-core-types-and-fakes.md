Status: resolved
Type: task
Blocked by: 01

# Core types, store interfaces, manifest, in-memory fakes

Define `LocalStore` and `RemoteStore` interfaces, the manifest model (path, SHA-256 hash, Drive file ID, last-synced revision), and in-memory fake implementations for tests. No Obsidian or Drive imports in `core/`.

Done when: fakes can hold files, report changes, and round-trip a manifest in tests.

Spec: ../spec.md

## Answer

src/core/types.ts (LocalStore, RemoteStore, RemoteFile, RemoteChange), src/core/manifest.ts (Manifest with JSON round-trip, lookup by remote id, cursor), src/core/hash.ts (SHA-256 via Web Crypto). Fakes in tests/fakes.ts (FakeLocal, FakeRemote with change log, expiring cursors, injected failures, call log). Tests: tests/core-fakes.test.ts.
