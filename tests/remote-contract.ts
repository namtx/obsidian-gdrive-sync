import { expect, it } from "vitest";
import { sha256 } from "../src/core/hash";
import type { RemoteChange, RemoteStore } from "../src/core/types";

export const bytes = (s: string) => new TextEncoder().encode(s);

/** Wait for an eventually consistent backend (Drive's change feed can lag a moment). */
async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() - start > timeoutMs) return v;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const describeChange = (c: RemoteChange) => (c.kind === "upsert" ? `upsert ${c.file.path}` : `removed ${c.id}`);

/**
 * Behaviour every RemoteStore must have. Runs against the in-memory fake and,
 * when enabled, against a real Drive folder.
 */
export function remoteContract(
  make: () => Promise<RemoteStore>,
  opts: { settleMs?: number; largeSize?: number; timeout?: number } = {},
) {
  const settle = opts.settleMs ?? 0;
  const t = opts.timeout;

  it("creates files in nested folders and lists them with content hashes", async () => {
    const store = await make();
    const created = await store.upload("dir/sub/a.md", bytes("hello"));
    expect(created.path).toBe("dir/sub/a.md");
    expect(created.hash).toBe(await sha256(bytes("hello")));

    const { files } = await store.listAll();
    expect(files.map((f) => [f.path, f.id, f.hash])).toEqual([["dir/sub/a.md", created.id, created.hash]]);
  }, t);

  it("updates content in place, keeping the id and changing the revision", async () => {
    const store = await make();
    const binary = new Uint8Array(256).map((_, i) => i);
    const first = await store.upload("img.bin", binary);
    const second = await store.upload("img.bin", bytes("v2"), first.id);

    expect(second.id).toBe(first.id);
    expect(second.revision).not.toBe(first.revision);
    expect(second.hash).toBe(await sha256(bytes("v2")));
    expect(new TextDecoder().decode(await store.download(first.id))).toBe("v2");
  }, t);

  it("round-trips binary content exactly", async () => {
    const store = await make();
    const binary = new Uint8Array(1024).map((_, i) => (i * 7) % 256);
    const f = await store.upload("raw.bin", binary);
    expect(await store.download(f.id)).toEqual(binary);
  }, t);

  it("moves a file by id to a new folder without changing its content", async () => {
    const store = await make();
    const f = await store.upload("old.md", bytes("x"));
    const moved = await store.move(f.id, "new/place.md");

    expect(moved).toMatchObject({ id: f.id, path: "new/place.md", hash: f.hash });
    const { files } = await store.listAll();
    expect(files.map((x) => x.path)).toEqual(["new/place.md"]);
  }, t);

  it("trashes a file so it disappears from listings", async () => {
    const store = await make();
    const keep = await store.upload("keep.md", bytes("k"));
    const gone = await store.upload("gone.md", bytes("g"));
    await store.trash(gone.id);

    const { files } = await store.listAll();
    expect(files.map((x) => x.id)).toEqual([keep.id]);
  }, t);

  it("reports creates, updates, moves and trashes since a cursor", async () => {
    const store = await make();
    const a = await store.upload("a.md", bytes("a"));
    const b = await store.upload("b.md", bytes("b"));
    const c = await store.upload("c.md", bytes("c"));
    await new Promise((r) => setTimeout(r, settle));
    const { cursor } = await store.listAll();

    await store.upload("a.md", bytes("a2"), a.id);
    await store.move(b.id, "moved/b.md");
    await store.trash(c.id);
    const d = await store.upload("d.md", bytes("d"));

    const expected = new Map<string, string>([
      [a.id, "upsert a.md"],
      [b.id, "upsert moved/b.md"],
      [c.id, `removed ${c.id}`],
      [d.id, "upsert d.md"],
    ]);
    // Apply in order and keep the last change per id: the engine only cares about final state.
    const finalState = async () => {
      const delta = await store.changesSince(cursor);
      const last = new Map<string, RemoteChange>();
      for (const ch of delta?.changes ?? []) last.set(ch.kind === "upsert" ? ch.file.id : ch.id, ch);
      return { delta, last };
    };
    const { delta, last } = await eventually(finalState, (s) => [...expected.keys()].every((id) => s.last.has(id)), 30_000);

    expect(delta).not.toBeNull();
    for (const [id, want] of expected) expect(last.get(id) && describeChange(last.get(id)!)).toBe(want);
    const upA = last.get(a.id) as Extract<RemoteChange, { kind: "upsert" }>;
    expect(upA.file.hash).toBe(await sha256(bytes("a2")));
  }, t);

  it("reports no effective change when nothing changed", async () => {
    const store = await make();
    await store.upload("a.md", bytes("a"));
    await new Promise((r) => setTimeout(r, settle));
    const { files, cursor } = await store.listAll();
    await new Promise((r) => setTimeout(r, settle));

    // A lagging feed may repeat a change already in the listing; the engine skips those
    // because path and hash match. Anything else would cause a spurious transfer.
    const delta = await store.changesSince(cursor);
    const listed = new Map(files.map((f) => [f.id, `${f.path} ${f.hash}`]));
    for (const c of delta!.changes) {
      expect(c.kind).toBe("upsert");
      if (c.kind === "upsert") expect(`${c.file.path} ${c.file.hash}`).toBe(listed.get(c.file.id));
    }
  }, t);

  it("rejects an invalid cursor so the caller falls back to a full listing", async () => {
    const store = await make();
    expect(await store.changesSince("not-a-cursor")).toBeNull();
  }, t);

  it("uploads and updates large files", async () => {
    const store = await make();
    const size = opts.largeSize ?? 600 * 1024;
    const big = new Uint8Array(size).map((_, i) => (i * 31) % 251);
    const f = await store.upload("big/file.bin", big);
    expect(f.hash).toBe(await sha256(big));
    expect(await store.download(f.id)).toEqual(big);

    const big2 = big.map((x) => 255 - x);
    const g = await store.upload("big/file.bin", big2, f.id);
    expect(g.id).toBe(f.id);
    expect(await store.download(f.id)).toEqual(big2);
  }, t);
}
