import { describe, expect, it } from "vitest";
import { conflictPath, isMergeable, mergeText } from "../src/core/merge";
import { world } from "./harness";

describe("mergeText", () => {
  const base = "one\ntwo\nthree\nfour\nfive\n";

  it("combines edits to different lines", () => {
    expect(mergeText("ONE\ntwo\nthree\nfour\nfive\n", base, "one\ntwo\nthree\nfour\nFIVE\n")).toBe(
      "ONE\ntwo\nthree\nfour\nFIVE\n",
    );
  });

  it("accepts identical edits on both sides", () => {
    expect(mergeText("one\nTWO\nthree\nfour\nfive\n", base, "one\nTWO\nthree\nfour\nfive\n")).toBe(
      "one\nTWO\nthree\nfour\nfive\n",
    );
  });

  it("returns null for overlapping edits", () => {
    expect(mergeText("one\nmac\nthree\nfour\nfive\n", base, "one\nphone\nthree\nfour\nfive\n")).toBeNull();
  });

  it("handles a missing trailing newline and empty files", () => {
    expect(mergeText("a\nb", "a\nb", "a\nb\nc")).toBe("a\nb\nc");
    expect(mergeText("", "", "new\n")).toBe("new\n");
  });
});

describe("conflictPath", () => {
  const day = new Date("2026-10-30T12:00:00Z");
  it("inserts device and date before the extension", () => {
    expect(conflictPath("dir/note.md", "Mac", day, () => false)).toBe("dir/note (conflict Mac 2026-10-30).md");
    expect(conflictPath("my.dir/README", "Mac", day, () => false)).toBe("my.dir/README (conflict Mac 2026-10-30)");
  });
  it("numbers the copy when the name is taken", () => {
    const taken = new Set(["note (conflict Mac 2026-10-30).md"]);
    expect(conflictPath("note.md", "Mac", day, (p) => taken.has(p))).toBe("note (conflict Mac 2026-10-30 2).md");
  });
  it("strips characters that are illegal in file names", () => {
    expect(conflictPath("n.md", "Nam's Mac/Pro", day, () => false)).toBe("n (conflict Nam's Mac-Pro 2026-10-30).md");
  });
});

describe("isMergeable", () => {
  it("treats Markdown and text as mergeable", () => {
    expect(isMergeable("a/b.md")).toBe(true);
    expect(isMergeable("a.TXT")).toBe(true);
    expect(isMergeable("a.png")).toBe(false);
    expect(isMergeable("a.canvas")).toBe(false);
  });
});

describe("conflicts during sync", () => {
  async function shared(path: string, content: string) {
    const w = world();
    w.mac.local.put(path, content);
    await w.mac.syncOk();
    await w.phone.syncOk();
    return w;
  }

  it("merges non-overlapping edits cleanly on both devices", async () => {
    const { mac, phone, remote } = await shared("note.md", "title\n\nbody\n\nfooter\n");
    mac.local.put("note.md", "TITLE\n\nbody\n\nfooter\n");
    phone.local.put("note.md", "title\n\nbody\n\nFOOTER\n");
    await phone.syncOk();

    const result = await mac.syncOk();

    expect(result.log).toContainEqual({ action: "conflict", path: "note.md", ok: true, detail: "merged" });
    expect(mac.local.text("note.md")).toBe("TITLE\n\nbody\n\nFOOTER\n");
    expect(remote.text("note.md")).toBe("TITLE\n\nbody\n\nFOOTER\n");
    await phone.syncOk();
    expect(phone.local.text("note.md")).toBe("TITLE\n\nbody\n\nFOOTER\n");
    expect(remote.paths()).toEqual(["note.md"]);
  });

  it("keeps both versions on an overlapping edit", async () => {
    const { mac, phone, remote } = await shared("note.md", "line\n");
    mac.local.put("note.md", "mac edit\n");
    phone.local.put("note.md", "phone edit\n");
    await phone.syncOk();

    await mac.syncOk();
    await phone.syncOk();

    const copy = "note (conflict Mac 2026-10-30).md";
    for (const device of [mac, phone]) {
      expect(device.local.text("note.md")).toBe("phone edit\n");
      expect(device.local.text(copy)).toBe("mac edit\n");
    }
    expect(remote.paths()).toEqual([copy, "note.md"]);
  });

  it("falls back to keep-both when the base copy is missing", async () => {
    const { mac, phone } = await shared("note.md", "a\nb\nc\n");
    mac.local.put("note.md", "A\nb\nc\n");
    phone.local.put("note.md", "a\nb\nC\n");
    await phone.syncOk();
    mac.base.files.clear();

    await mac.syncOk();

    expect(mac.local.text("note.md")).toBe("a\nb\nC\n");
    expect(mac.local.text("note (conflict Mac 2026-10-30).md")).toBe("A\nb\nc\n");
  });

  it("binary conflict: the newer local edit wins and overwrites the remote", async () => {
    const { mac, phone, remote } = await shared("pic.png", "v1");
    phone.local.put("pic.png", "phone");
    await phone.syncOk();
    mac.local.put("pic.png", "mac (newer)");

    const result = await mac.syncOk();

    expect(result.log).toContainEqual({ action: "conflict", path: "pic.png", ok: true, detail: "kept local (newer)" });
    expect(remote.text("pic.png")).toBe("mac (newer)");
    expect(remote.paths()).toEqual(["pic.png"]);
  });

  it("binary conflict: the newer remote edit wins and the older local edit is kept as a copy", async () => {
    const { mac, phone, remote } = await shared("pic.png", "v1");
    mac.local.put("pic.png", "mac (older)");
    phone.local.put("pic.png", "phone (newer)");
    await phone.syncOk();

    await mac.syncOk();

    expect(mac.local.text("pic.png")).toBe("phone (newer)");
    expect(mac.local.text("pic (conflict Mac 2026-10-30).png")).toBe("mac (older)");
    expect(remote.paths()).toEqual(["pic (conflict Mac 2026-10-30).png", "pic.png"]);
  });
});
