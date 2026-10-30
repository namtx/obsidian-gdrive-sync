import { readFileSync } from "node:fs";
import { afterAll, describe } from "vitest";
import { DriveClient } from "../src/drive/client";
import { TokenManager, type Tokens } from "../src/drive/oauth";
import { DriveRemoteStore } from "../src/drive/remote";
import { nodeHttp } from "./node-http";
import { remoteContract } from "./remote-contract";

/**
 * Runs the RemoteStore contract against real Google Drive, inside a throwaway
 * `ObsidianSync-test/<run>/<case>` folder that is trashed afterwards.
 *
 *   DRIVE_LIVE=<path to the plugin's data.json> npx vitest run tests/drive-live.test.ts
 */
const dataPath = process.env.DRIVE_LIVE;

describe.skipIf(!dataPath)("RemoteStore contract: Google Drive (live)", () => {
  const data = dataPath ? JSON.parse(readFileSync(dataPath, "utf8")) : null;
  const run = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const client = { clientId: data?.clientId, clientSecret: data?.clientSecret };
  // Tokens refreshed here are kept in memory only; the plugin's data.json is never written.
  const tokens = new TokenManager(nodeHttp, client, data?.tokens as Tokens, async () => {});
  const drive = new DriveClient(nodeHttp, tokens);
  const stores: DriveRemoteStore[] = [];
  let n = 0;

  // Trash this run's files and folders. The shared top-level folder stays: with drive.file, Drive
  // refuses (403) to trash or delete it once it has trashed children.
  afterAll(async () => {
    for (const s of stores) await s.trashRoot().catch((e) => console.warn(`cleanup: ${e.message}`));
    await new DriveRemoteStore(drive, { rootPath: ["ObsidianSync-test", run] })
      .trashRoot()
      .catch((e) => console.warn(`cleanup: ${e.message}`));
  }, 120_000);

  remoteContract(
    async () => {
      // Small thresholds so the "large file" case exercises resumable, multi-chunk uploads.
      const store = new DriveRemoteStore(drive, {
        rootPath: ["ObsidianSync-test", run, `case-${++n}`],
        resumableThreshold: 256 * 1024,
        chunkSize: 256 * 1024,
      });
      stores.push(store);
      return store;
    },
    { settleMs: 2000, largeSize: 600 * 1024, timeout: 90_000 },
  );
});
