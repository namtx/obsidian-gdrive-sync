import { describe, expect, it } from "vitest";
import { Manifest } from "../src/core/manifest";
import { plan, type LocalState } from "../src/core/plan";
import type { RemoteFile } from "../src/core/types";

const L = (path: string, hash: string, mtime = 1): LocalState => ({ path, hash, mtime });
const R = (path: string, hash: string, id = `id-${path}`): RemoteFile => ({
  id,
  path,
  hash,
  revision: `rev-${hash}`,
  size: 1,
  mtime: 1,
});

function run(opts: { local?: LocalState[]; remote?: RemoteFile[]; base?: Array<[string, string]> }) {
  const manifest = new Manifest();
  for (const [path, hash] of opts.base ?? [])
    manifest.set({ path, hash, remoteId: `id-${path}`, revision: `rev-${hash}` });
  return plan(
    new Map((opts.local ?? []).map((f) => [f.path, f])),
    new Map((opts.remote ?? []).map((f) => [f.path, f])),
    manifest,
  );
}

const summary = (actions: ReturnType<typeof plan>) => actions.map((a) => `${a.type} ${a.path}`);

describe("plan", () => {
  it("does nothing when both sides match the manifest", () => {
    expect(run({ local: [L("a.md", "h1")], remote: [R("a.md", "h1")], base: [["a.md", "h1"]] })).toEqual([]);
  });

  it("does nothing on an empty vault", () => {
    expect(run({})).toEqual([]);
  });

  it("uploads a file created locally", () => {
    expect(run({ local: [L("new.md", "h1")] })).toEqual([{ type: "upload", path: "new.md", remoteId: undefined }]);
  });

  it("uploads a local edit onto the existing remote file", () => {
    expect(run({ local: [L("a.md", "h2")], remote: [R("a.md", "h1")], base: [["a.md", "h1"]] })).toEqual([
      { type: "upload", path: "a.md", remoteId: "id-a.md", expectedHash: "h1" },
    ]);
  });

  it("downloads a file created remotely", () => {
    const remote = R("new.md", "h1");
    expect(run({ remote: [remote] })).toEqual([{ type: "download", path: "new.md", remote }]);
  });

  it("downloads a remote edit", () => {
    const remote = R("a.md", "h2");
    expect(run({ local: [L("a.md", "h1")], remote: [remote], base: [["a.md", "h1"]] })).toEqual([
      { type: "download", path: "a.md", remote },
    ]);
  });

  it("ignores modified times when content is unchanged", () => {
    expect(
      run({ local: [L("a.md", "h1", 99_999)], remote: [R("a.md", "h1")], base: [["a.md", "h1"]] }),
    ).toEqual([]);
  });

  it("records without transfer when both sides changed to the same content", () => {
    expect(summary(run({ local: [L("a.md", "h2")], remote: [R("a.md", "h2")], base: [["a.md", "h1"]] }))).toEqual([
      "record a.md",
    ]);
  });

  it("flags a conflict when both sides changed differently", () => {
    expect(summary(run({ local: [L("a.md", "h2")], remote: [R("a.md", "h3")], base: [["a.md", "h1"]] }))).toEqual([
      "conflict a.md",
    ]);
  });

  it("plans each path independently and in sorted order", () => {
    expect(
      summary(
        run({
          local: [L("b.md", "h1"), L("c.md", "h2")],
          remote: [R("a.md", "h1"), R("c.md", "h1")],
          base: [["c.md", "h1"]],
        }),
      ),
    ).toEqual(["download a.md", "upload b.md", "upload c.md"]);
  });
});
