import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { MemoryBaseStore } from "../src/core/base";
import { SyncEngine, type SyncOptions } from "../src/core/engine";
import { Manifest } from "../src/core/manifest";
import { DriveClient } from "../src/drive/client";
import type { Http } from "../src/drive/http";
import { TokenManager, type Tokens } from "../src/drive/oauth";
import { DriveRemoteStore } from "../src/drive/remote";
import { FakeLocal } from "./fakes";
import { nodeHttp } from "./node-http";

/**
 * End-to-end: the real sync engine on two simulated devices, each with its own
 * Drive store, against one throwaway Drive folder.
 *
 *   DRIVE_LIVE=<path to the plugin's data.json> npx vitest run tests/sync-live.test.ts
 */
const dataPath = process.env.DRIVE_LIVE;

describe.skipIf(!dataPath)("sync engine against Google Drive (live)", () => {
  const data = dataPath ? JSON.parse(readFileSync(dataPath, "utf8")) : null;
  const rootPath = ["ObsidianSync-test", `sync-${new Date().toISOString().replace(/[:.]/g, "-")}`];
  const tokens = new TokenManager(
    nodeHttp,
    { clientId: data?.clientId, clientSecret: data?.clientSecret },
    data?.tokens as Tokens,
    async () => {},
  );

  class Device {
    local = new FakeLocal();
    requests: string[] = [];
    engine: SyncEngine;
    constructor(public name: string) {
      const logging: Http = async (req) => {
        this.requests.push(`${req.method ?? "GET"} ${req.url.replace(/\?.*/, "")}`);
        return nodeHttp(req);
      };
      const store = new DriveRemoteStore(new DriveClient(logging, tokens), { rootPath });
      this.engine = new SyncEngine(this.local, store, new MemoryBaseStore(), new Manifest());
    }
    sync(opts: Partial<SyncOptions> = {}) {
      return this.engine.sync({ device: this.name, confirmFirstSync: true, ...opts });
    }
    /**
     * Sync until `done` holds. Drive's change feed can lag a few seconds; meanwhile a sync may be
     * partial because a write was skipped on purpose (remote changed), never because of an error.
     */
    async syncUntil(done: () => boolean, opts: Partial<SyncOptions> = {}) {
      let last = "";
      for (let i = 0; i < 15; i++) {
        const r = await this.sync(opts);
        const unexpected = r.log.filter((e) => !e.ok && !/changed on Drive/.test(e.detail ?? ""));
        expect(unexpected).toEqual([]);
        last = JSON.stringify(r.log);
        if (r.status === "synced" && done()) return;
        await new Promise((res) => setTimeout(res, 2000));
      }
      throw new Error(`${this.name}: not converged; last log ${last}`);
    }
  }

  const mac = new Device("Mac");
  const phone = new Device("iPhone");

  afterAll(async () => {
    await new DriveRemoteStore(new DriveClient(nodeHttp, tokens), { rootPath })
      .trashRoot()
      .catch((e) => console.warn(`cleanup: ${e.message}`));
  }, 120_000);

  it("first sync: the Mac uploads and the phone downloads", async () => {
    mac.local.put("Welcome.md", "# Welcome\n\nline\n").put("daily/2026-10-30.md", "today\n").put("img/pic.png", "PNG");
    expect((await mac.sync()).status).toBe("synced");

    await phone.syncUntil(() => phone.local.files.size === 3);
    expect(phone.local.text("daily/2026-10-30.md")).toBe("today\n");
  }, 120_000);

  it("a sync with no changes makes no per-file calls", async () => {
    await new Promise((r) => setTimeout(r, 3000));
    await mac.sync(); // absorb any lagging echoes of our own uploads
    mac.requests = [];

    const r = await mac.sync();

    expect(r.status).toBe("synced");
    expect(mac.requests).toEqual(["GET https://www.googleapis.com/drive/v3/changes"]);
  }, 60_000);

  it("edits, renames and deletes on the phone reach the Mac", async () => {
    phone.local.put("daily/2026-10-30.md", "today\nfrom phone\n");
    await phone.local.rename("img/pic.png", "attachments/pic.png");
    await phone.local.delete("Welcome.md");
    const r = await phone.sync({ renameEvents: [{ from: "img/pic.png", to: "attachments/pic.png" }], confirmDeletes: true });
    expect(r.status, JSON.stringify(r.log)).toBe("synced");

    await mac.syncUntil(
      () =>
        !mac.local.files.has("Welcome.md") &&
        mac.local.files.has("attachments/pic.png") &&
        mac.local.text("daily/2026-10-30.md") === "today\nfrom phone\n",
      { confirmDeletes: true },
    );
    expect([...mac.local.files.keys()].sort()).toEqual(["attachments/pic.png", "daily/2026-10-30.md"]);
    expect(mac.local.text("daily/2026-10-30.md")).toBe("today\nfrom phone\n");
  }, 120_000);

  it("concurrent edits to different lines merge on both devices", async () => {
    mac.local.put("daily/2026-10-30.md", "TODAY\nfrom phone\n");
    phone.local.put("daily/2026-10-30.md", "today\nfrom phone\nand more\n");
    const r = await phone.sync();
    expect(r.status, JSON.stringify(r.log)).toBe("synced");

    await mac.syncUntil(() => mac.local.text("daily/2026-10-30.md") === "TODAY\nfrom phone\nand more\n");
    await phone.syncUntil(() => phone.local.text("daily/2026-10-30.md") === "TODAY\nfrom phone\nand more\n");
  }, 120_000);
});
