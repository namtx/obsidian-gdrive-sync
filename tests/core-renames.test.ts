import { describe, expect, it } from "vitest";
import { collapseRenames } from "../src/core/renames";
import { world } from "./harness";

async function synced(files: Record<string, string>) {
  const w = world();
  for (const [path, content] of Object.entries(files)) w.mac.local.put(path, content);
  await w.mac.syncOk();
  await w.phone.syncOk();
  w.remote.calls = [];
  return w;
}

describe("collapseRenames", () => {
  it("follows chains and drops round trips", () => {
    expect(
      collapseRenames([
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "x", to: "y" },
        { from: "y", to: "x" },
      ]),
    ).toEqual([{ from: "a", to: "c" }]);
  });
});

describe("renames", () => {
  it("applies a vault rename event as a Drive move without re-upload", async () => {
    const { mac, phone, remote } = await synced({ "old.md": "content" });
    const id = remote.byPath("old.md")!.meta.id;
    await mac.local.rename("old.md", "dir/new.md");

    const result = await mac.syncOk({ renameEvents: [{ from: "old.md", to: "dir/new.md" }] });

    expect(result.summary.moves).toEqual([
      { side: "remote", from: "old.md", to: "dir/new.md", remoteId: id, via: "event" },
    ]);
    expect(remote.calls.filter((c) => !c.startsWith("changesSince"))).toEqual(["move old.md -> dir/new.md"]);
    expect(remote.byPath("dir/new.md")!.meta.id).toBe(id);

    await phone.syncOk();
    expect(phone.local.text("dir/new.md")).toBe("content");
    expect(phone.local.files.has("old.md")).toBe(false);
    expect(remote.calls.some((c) => c.startsWith("download") || c.startsWith("upload"))).toBe(false);
  });

  it("moves then uploads when a file was renamed and edited", async () => {
    const { mac, remote } = await synced({ "a.md": "v1" });
    await mac.local.rename("a.md", "b.md");
    mac.local.put("b.md", "v2");

    await mac.syncOk({ renameEvents: [{ from: "a.md", to: "b.md" }] });

    expect(remote.calls.filter((c) => !c.startsWith("changesSince"))).toEqual(["move a.md -> b.md", "upload b.md"]);
    expect(remote.text("b.md")).toBe("v2");
  });

  it("detects a rename by content hash when no event was recorded", async () => {
    const { mac, remote } = await synced({ "a.md": "unique content" });
    const id = remote.byPath("a.md")!.meta.id;
    await mac.local.rename("a.md", "b.md");

    const result = await mac.syncOk();

    expect(result.summary.moves).toEqual([{ side: "remote", from: "a.md", to: "b.md", remoteId: id, via: "hash" }]);
    expect(remote.paths()).toEqual(["b.md"]);
  });

  it("does not guess a rename when duplicate content makes the match ambiguous", async () => {
    const { mac, remote } = await synced({ "a.md": "same", "b.md": "same" });
    await mac.local.rename("a.md", "c.md");
    await mac.local.rename("b.md", "d.md");

    const result = await mac.syncOk({ confirmDeletes: true });

    expect(result.summary.moves).toEqual([]);
    expect(result.summary.deleteRemote).toEqual(["a.md", "b.md"]);
    expect(result.summary.uploads).toEqual(["c.md", "d.md"]);
    expect(remote.paths()).toEqual(["c.md", "d.md"]);
  });

  it("renames locally when another device moved the file on Drive", async () => {
    const { mac, phone, remote } = await synced({ "a.md": "content" });
    await phone.local.rename("a.md", "b.md");
    await phone.syncOk({ renameEvents: [{ from: "a.md", to: "b.md" }] });
    remote.calls = [];

    const result = await mac.syncOk();

    expect(result.summary.moves).toMatchObject([{ side: "local", from: "a.md", to: "b.md" }]);
    expect([...mac.local.files.keys()]).toEqual(["b.md"]);
    expect(remote.calls.filter((c) => !c.startsWith("changesSince"))).toEqual([]);
  });

  it("carries the merge base along with a rename from another device", async () => {
    const { mac, phone } = await synced({ "a.md": "1\n2\n3\n4\n5\n" });
    await phone.local.rename("a.md", "b.md");
    await phone.syncOk({ renameEvents: [{ from: "a.md", to: "b.md" }] });
    await mac.syncOk();
    expect(mac.base.files.has("b.md")).toBe(true);

    mac.local.put("b.md", "one\n2\n3\n4\n5\n");
    phone.local.put("b.md", "1\n2\n3\n4\nfive\n");
    await phone.syncOk();
    const result = await mac.syncOk();

    expect(result.log).toContainEqual({ action: "conflict", path: "b.md", ok: true, detail: "merged" });
    expect(mac.local.text("b.md")).toBe("one\n2\n3\n4\nfive\n");
  });
});
