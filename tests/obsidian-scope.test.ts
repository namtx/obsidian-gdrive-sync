import { describe, expect, it } from "vitest";
import { inScope, type ScopeSettings } from "../src/obsidian/scope";
import { RenameJournal } from "../src/obsidian/rename-journal";
import { world } from "./harness";

const base: ScopeSettings = { configDir: ".obsidian", pluginDir: ".obsidian/plugins/gdrive-sync", syncConfig: false };
const withConfig = { ...base, syncConfig: true };

describe("inScope", () => {
  it("syncs notes and attachments", () => {
    for (const p of ["note.md", "daily/2026-10-30.md", "img/pic.png", "a b/c (1).pdf"]) expect(inScope(p, base)).toBe(true);
  });

  it("always excludes .trash, dotfiles and dotfolders", () => {
    for (const p of [".trash/old.md", ".trash", ".DS_Store", "dir/.DS_Store", ".git/config", "dir/.hidden/x.md"])
      expect(inScope(p, withConfig)).toBe(false);
  });

  it("excludes the config folder by default", () => {
    expect(inScope(".obsidian/app.json", base)).toBe(false);
    expect(inScope(".obsidian/plugins/dataview/main.js", base)).toBe(false);
  });

  it("syncs config when enabled, except workspace layouts and this plugin's folder", () => {
    expect(inScope(".obsidian/app.json", withConfig)).toBe(true);
    expect(inScope(".obsidian/themes/Minimal/theme.css", withConfig)).toBe(true);
    expect(inScope(".obsidian/plugins/dataview/data.json", withConfig)).toBe(true);
    for (const p of [
      ".obsidian/workspace.json",
      ".obsidian/workspace-mobile.json",
      ".obsidian/workspaces.json",
      ".obsidian/plugins/gdrive-sync/data.json",
      ".obsidian/plugins/gdrive-sync/bases/abc",
    ])
      expect(inScope(p, withConfig)).toBe(false);
  });

  it("respects a custom config folder name", () => {
    const custom = { configDir: ".config", pluginDir: ".config/plugins/gdrive-sync", syncConfig: true };
    expect(inScope(".config/app.json", custom)).toBe(true);
    expect(inScope(".config/workspace.json", custom)).toBe(false);
    expect(inScope(".obsidian/app.json", custom)).toBe(false);
  });
});

describe("scope and size cap in the engine", () => {
  const scope = (syncConfig: boolean) => (p: string) => inScope(p, { ...base, syncConfig });

  it("never uploads or downloads out-of-scope files", async () => {
    const { mac, remote } = world();
    mac.local.put("note.md", "n").put(".obsidian/workspace.json", "{}").put(".trash/old.md", "x");
    await remote.put(".obsidian/plugins/gdrive-sync/data.json", "secret");

    await mac.syncOk({ scope: scope(true) });

    expect(remote.paths()).toEqual([".obsidian/plugins/gdrive-sync/data.json", "note.md"]);
    expect(mac.local.files.has(".obsidian/plugins/gdrive-sync/data.json")).toBe(false);
  });

  it("turning config sync off later does not delete synced config from Drive", async () => {
    const { mac, remote } = world();
    mac.local.put("note.md", "n").put(".obsidian/app.json", "{}");
    await mac.syncOk({ scope: scope(true) });
    expect(remote.paths()).toContain(".obsidian/app.json");

    const result = await mac.syncOk({ scope: scope(false) });

    expect(result.summary.deleteRemote).toEqual([]);
    expect(remote.paths()).toContain(".obsidian/app.json");
  });

  it("skips files over the size cap, lists them, and never treats them as deleted", async () => {
    const { mac, phone, remote } = world();
    mac.local.put("small.md", "s").put("video.mp4", "x".repeat(100));
    const first = await mac.syncOk({ maxFileSize: 50 });
    expect(first.summary.skipped).toEqual(["video.mp4"]);
    expect(remote.paths()).toEqual(["small.md"]);

    // A file that grows past the cap is left alone on both sides.
    mac.local.put("small.md", "x".repeat(100));
    await phone.syncOk({ maxFileSize: 50 });
    const grown = await mac.syncOk({ maxFileSize: 50 });
    expect(grown.summary.skipped).toEqual(["small.md", "video.mp4"]);
    expect(grown.summary.deleteRemote).toEqual([]);
    expect(remote.text("small.md")).toBe("s");
    expect(phone.local.text("small.md")).toBe("s");
  });

  it("skips files that are over the cap on the remote side", async () => {
    const { phone, remote } = world();
    await remote.put("big.bin", "x".repeat(100));
    const result = await phone.syncOk({ maxFileSize: 50 });
    expect(result.summary.skipped).toEqual(["big.bin"]);
    expect(phone.local.files.has("big.bin")).toBe(false);
  });
});

describe("RenameJournal", () => {
  it("persists renames and drops only the consumed ones", async () => {
    const saved: unknown[] = [];
    const journal = new RenameJournal([], async (e) => void saved.push(e.map((x) => `${x.from}>${x.to}`)));
    await journal.record("a.md", "b.md");
    await journal.record("x.md", "x.md");
    const snap = journal.snapshot();
    await journal.record("b.md", "c.md"); // happens during the sync

    await journal.consumed(snap.length);

    expect(journal.snapshot()).toEqual([{ from: "b.md", to: "c.md" }]);
    expect(saved[saved.length - 1]).toEqual(["b.md>c.md"]);
  });

  it("caps its size", async () => {
    const journal = new RenameJournal([], async () => {}, 3);
    for (let i = 0; i < 5; i++) await journal.record(`${i}`, `${i + 1}`);
    expect(journal.snapshot().map((e) => e.from)).toEqual(["2", "3", "4"]);
  });
});
