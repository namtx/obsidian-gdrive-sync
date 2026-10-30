import { describe, expect, it } from "vitest";
import { Manifest, sha256 } from "../src/core";
import { FakeLocal, FakeRemote, str, text } from "./fakes";

describe("sha256", () => {
  it("hashes content as lowercase hex", async () => {
    expect(await sha256(text("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("FakeLocal", () => {
  it("holds, renames and deletes files", async () => {
    const local = new FakeLocal().put("a.md", "A");
    await local.write("dir/b.md", text("B"));
    await local.rename("a.md", "c.md");
    await local.delete("dir/b.md");
    expect((await local.list()).map((f) => f.path)).toEqual(["c.md"]);
    expect(str(await local.read("c.md"))).toBe("A");
  });
});

describe("FakeRemote", () => {
  it("reports changes since a cursor", async () => {
    const remote = new FakeRemote();
    const a = await remote.put("a.md", "A");
    const { cursor } = await remote.listAll();

    await remote.put("a.md", "A2");
    await remote.put("b.md", "B");
    remote.remove("a.md");

    const delta = await remote.changesSince(cursor);
    expect(delta?.changes.map((c) => (c.kind === "upsert" ? `upsert ${c.file.path}` : `removed ${c.id}`))).toEqual([
      "upsert a.md",
      "upsert b.md",
      `removed ${a.id}`,
    ]);
    expect(await remote.changesSince(delta!.cursor)).toEqual({ changes: [], cursor: delta!.cursor });
  });

  it("keeps the file id and changes the revision on update", async () => {
    const remote = new FakeRemote();
    const first = await remote.put("a.md", "A");
    const second = await remote.upload("a.md", text("A2"), first.id);
    expect(second.id).toBe(first.id);
    expect(second.revision).not.toBe(first.revision);
    expect(second.hash).toBe(await sha256(text("A2")));
  });

  it("rejects an expired cursor", async () => {
    const remote = new FakeRemote();
    await remote.put("a.md", "A");
    remote.oldestValidCursor = 1;
    expect(await remote.changesSince("0")).toBeNull();
  });
});

describe("Manifest", () => {
  it("round-trips through JSON", () => {
    const manifest = new Manifest();
    manifest.cursor = "42";
    manifest.set({ path: "a.md", hash: "h1", remoteId: "id1", revision: "r1" });
    manifest.set({ path: "b/c.png", hash: "h2", remoteId: "id2", revision: "r2" });

    const restored = Manifest.fromJSON(JSON.parse(JSON.stringify(manifest.toJSON())));

    expect(restored.cursor).toBe("42");
    expect(restored.get("b/c.png")).toEqual({ path: "b/c.png", hash: "h2", remoteId: "id2", revision: "r2" });
    expect(restored.findByRemoteId("id1")?.path).toBe("a.md");
    expect(restored.size).toBe(2);
  });

  it("starts empty from missing data", () => {
    const manifest = Manifest.fromJSON(undefined);
    expect(manifest.size).toBe(0);
    expect(manifest.cursor).toBeNull();
  });
});
