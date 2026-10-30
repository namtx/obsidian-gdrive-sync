Status: open
Type: task
Blocked by: 02, 09

# Drive: RemoteStore over the Drive REST API

Implement `RemoteStore` with `requestUrl`: visible `ObsidianSync/<vault>/` mirrored tree, create, update, download, rename by file ID, delete to trash, resumable uploads for large files, exponential backoff on 429 and 5xx.

Done when: integration run against a real Drive folder passes the same contract tests as the in-memory fake.

Spec: ../spec.md
