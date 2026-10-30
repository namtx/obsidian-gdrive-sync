import { describe, expect, it } from "vitest";
import { world } from "./harness";

describe("first sync", () => {
  it("requires confirmation and changes nothing until confirmed", async () => {
    const { mac, remote } = world();
    mac.local.put("a.md", "A");

    const result = await mac.sync();

    expect(result).toMatchObject({ status: "needsConfirmation", reason: "firstSync" });
    expect(result.summary.uploads).toEqual(["a.md"]);
    expect(remote.paths()).toEqual([]);
    expect(mac.saved).toBeNull();
  });

  it("dry run reports the plan without changing anything", async () => {
    const { mac, remote } = world();
    mac.local.put("a.md", "A");
    expect((await mac.sync({ dryRun: true })).status).toBe("dryRun");
    expect(remote.paths()).toEqual([]);
  });

  it("empty remote: uploads the whole vault", async () => {
    const { mac, remote } = world();
    mac.local.put("a.md", "A").put("img/b.png", "B");

    const result = await mac.syncOk();

    expect(result.summary.uploads).toEqual(["a.md", "img/b.png"]);
    expect(remote.paths()).toEqual(["a.md", "img/b.png"]);
    expect(mac.manifest.cursor).not.toBeNull();
  });

  it("empty local: downloads everything from Drive", async () => {
    const { phone, remote } = world();
    await remote.put("a.md", "A");
    await remote.put("img/b.png", "B");

    const result = await phone.syncOk();

    expect(result.summary.downloads).toEqual(["a.md", "img/b.png"]);
    expect(phone.local.text("a.md")).toBe("A");
    expect(phone.local.text("img/b.png")).toBe("B");
  });

  it("identical: records files without any transfer", async () => {
    const { phone, remote } = world();
    await remote.put("a.md", "A");
    phone.local.put("a.md", "A");
    remote.calls = [];

    const result = await phone.syncOk();

    expect(result.summary.unchanged).toEqual(["a.md"]);
    expect(remote.calls).toEqual(["listAll"]);
    expect(phone.manifest.get("a.md")?.remoteId).toBe(remote.byPath("a.md")!.meta.id);
  });

  it("divergent: one-sided files copy, differing files keep both", async () => {
    const { phone, remote } = world();
    await remote.put("same.md", "S");
    await remote.put("only-remote.md", "R");
    await remote.put("differs.md", "remote version");
    phone.local.put("same.md", "S").put("only-local.md", "L").put("differs.md", "phone version");

    const dry = await phone.sync();
    expect(dry.summary).toMatchObject({
      uploads: ["only-local.md"],
      downloads: ["only-remote.md"],
      unchanged: ["same.md"],
      conflicts: ["differs.md"],
    });

    await phone.syncOk();

    const copy = "differs (conflict iPhone 2026-10-30).md";
    expect(phone.local.text("differs.md")).toBe("remote version");
    expect(phone.local.text(copy)).toBe("phone version");
    expect(remote.paths()).toEqual([copy, "differs.md", "only-local.md", "only-remote.md", "same.md"]);
  });

  it("later syncs use Drive changes instead of a full listing", async () => {
    const { mac, remote } = world();
    mac.local.put("a.md", "A");
    await mac.syncOk();
    const cursor = mac.manifest.cursor;
    remote.calls = [];

    await mac.syncOk();

    expect(remote.calls).toEqual([`changesSince ${cursor}`]);
  });

  it("falls back to a full listing when the stored cursor expired", async () => {
    const { mac, phone, remote } = world();
    mac.local.put("a.md", "A");
    await mac.syncOk();
    await phone.syncOk();
    mac.local.put("a.md", "A2");
    await mac.syncOk();
    remote.oldestValidCursor = Number.MAX_SAFE_INTEGER;

    await phone.syncOk();

    expect(phone.local.text("a.md")).toBe("A2");
  });
});
