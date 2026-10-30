Status: resolved
Type: task
Blocked by: 02, 09

# Drive: RemoteStore over the Drive REST API

Implement `RemoteStore` with `requestUrl`: visible `ObsidianSync/<vault>/` mirrored tree, create, update, download, rename by file ID, delete to trash, resumable uploads for large files, exponential backoff on 429 and 5xx.

Done when: integration run against a real Drive folder passes the same contract tests as the in-memory fake.

Spec: ../spec.md

## Answer

src/drive/client.ts (DriveClient: bearer auth, one token refresh on 401, exponential backoff with jitter on 429/5xx/rate-limit 403/network errors) and src/drive/remote.ts (DriveRemoteStore). Visible tree My Drive/ObsidianSync/<vault>/; paths come from parent links, built from one paginated listing. Creates use pre-generated ids (generateIds), so a retried create gets 409 instead of a duplicate. Files of 5 MB and up use resumable upload in 8 MB chunks, resuming from Drive's reported Range. Rename by id (PATCH addParents/removeParents + name); trash via trashed=true. Contract tests (tests/remote-contract.ts) pass against FakeRemote and against real Drive (tests/drive-live.test.ts, `npm run test:live`; throwaway ObsidianSync-test/<run> folders). Found live: (1) Drive's change feed lags, which let a blind upload overwrite another device's newer edit; fixed with an expected-hash precondition on upload/trash (RemoteChangedError; the file is skipped and retried next sync; fake has a `lag` switch, tests in core-resilience). (2) With drive.file, Drive refuses (403) to trash or delete a folder with trashed children: sync only trashes files; test cleanup trashes bottom-up and leaves the empty ObsidianSync-test folder.
