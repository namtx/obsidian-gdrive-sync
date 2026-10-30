import { describe, expect, it } from "vitest";
import type { RetryPolicy } from "../src/core/engine";
import { world } from "./harness";

describe("resilience", () => {
  it("a failed upload leaves the rest synced; a retry after restart finishes without duplicates", async () => {
    const { mac, remote } = world();
    mac.local.put("a.md", "A").put("b.md", "B").put("c.md", "C");
    remote.failOn.add("b.md");

    const first = await mac.sync({ confirmFirstSync: true });

    expect(first.status).toBe("partial");
    expect(first.log.filter((e) => !e.ok)).toMatchObject([{ action: "upload", path: "b.md" }]);
    expect(remote.paths()).toEqual(["a.md", "c.md"]);
    expect(mac.saved!.entries.map((e) => e.path).sort()).toEqual(["a.md", "c.md"]);

    remote.failOn.clear();
    mac.restart();
    remote.calls = [];
    await mac.syncOk();

    expect(remote.calls.filter((c) => c.startsWith("upload"))).toEqual(["upload b.md"]);
    expect(remote.paths()).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("a failed download is retried from the same remote changes", async () => {
    const { mac, phone, remote } = world();
    mac.local.put("a.md", "A").put("b.md", "B");
    await mac.syncOk();
    await phone.syncOk();
    mac.local.put("a.md", "A2").put("b.md", "B2");
    await mac.syncOk();
    remote.failOn.add("a.md");

    const first = await phone.sync();
    expect(first.status).toBe("partial");
    expect(phone.local.text("b.md")).toBe("B2");
    expect(phone.local.text("a.md")).toBe("A");

    remote.failOn.clear();
    phone.restart();
    await phone.syncOk();

    expect(phone.local.text("a.md")).toBe("A2");
    expect([...phone.local.files.keys()].sort()).toEqual(["a.md", "b.md"]);
  });

  it("a crash after Drive accepted an upload but before the manifest saved does not duplicate the file", async () => {
    const { mac, remote } = world();
    mac.local.put("a.md", "A");
    let crash = true;
    const result = await mac.sync({
      confirmFirstSync: true,
      commit: async () => {
        if (crash) throw new Error("app killed");
      },
    });
    expect(result.status).toBe("partial");
    expect(remote.paths()).toEqual(["a.md"]);

    crash = false;
    mac.restart();
    remote.calls = [];
    const retry = await mac.syncOk();

    expect(retry.summary.unchanged).toEqual(["a.md"]);
    expect(remote.calls.filter((c) => c.startsWith("upload"))).toEqual([]);
  });

  it("never overwrites a local file edited after the scan", async () => {
    const { mac, phone, remote } = world();
    mac.local.put("a.md", "A");
    await mac.syncOk();
    await phone.syncOk();
    mac.local.put("a.md", "from mac");
    await mac.syncOk();

    // The phone edits a.md between the scan and the download.
    const download = remote.download.bind(remote);
    remote.download = async (id) => {
      phone.local.put("a.md", "typed during sync");
      return download(id);
    };
    const result = await phone.sync();

    expect(result.status).toBe("partial");
    expect(phone.local.text("a.md")).toBe("typed during sync");

    // Next sync sees a real conflict and keeps both edits.
    remote.download = download;
    await phone.syncOk();
    expect(phone.local.text("a.md")).toBe("from mac");
    expect(phone.local.text("a (conflict iPhone 2026-10-30).md")).toBe("typed during sync");
  });

  it("runs every action through the retry policy", async () => {
    const { mac, remote } = world();
    mac.local.put("a.md", "A");
    remote.failOn.add("a.md");
    let attempts = 0;
    const retry: RetryPolicy = async (op) => {
      for (;;) {
        try {
          attempts++;
          return await op();
        } catch (e) {
          if (attempts >= 3) throw e;
          remote.failOn.clear();
        }
      }
    };

    await mac.syncOk({ retry });

    expect(attempts).toBe(2);
    expect(remote.paths()).toEqual(["a.md"]);
  });
});
