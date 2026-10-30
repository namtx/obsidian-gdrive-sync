import { describe, expect, it } from "vitest";
import { configChanges, inScope, NO_CONFIG_SYNC, type ScopeSettings } from "../src/obsidian/scope";
import { RenameJournal } from "../src/obsidian/rename-journal";
import { world } from "./harness";

const base: ScopeSettings = { configDir: ".obsidian", pluginDir: ".obsidian/plugins/gdrive-sync", config: NO_CONFIG_SYNC };
const all = { plugins: true, settings: true, themes: true };
const withConfig: ScopeSettings = { ...base, config: all };

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

  it("syncs each part of the config folder only when its toggle is on", () => {
    const only = (key: keyof typeof all) => ({ ...base, config: { ...NO_CONFIG_SYNC, [key]: true } });
    const paths = {
      plugins: [".obsidian/community-plugins.json", ".obsidian/plugins/dataview/main.js", ".obsidian/plugins/dataview/data.json"],
      settings: [".obsidian/app.json", ".obsidian/hotkeys.json", ".obsidian/core-plugins.json", ".obsidian/appearance.json"],
      themes: [".obsidian/themes/Minimal/theme.css", ".obsidian/snippets/wide.css"],
    };
    for (const key of ["plugins", "settings", "themes"] as const)
      for (const [category, list] of Object.entries(paths))
        for (const path of list) expect(inScope(path, only(key)), `${key} toggle, ${path}`).toBe(category === key);
  });

  it("respects a custom config folder name", () => {
    const custom = { configDir: ".config", pluginDir: ".config/plugins/gdrive-sync", config: all };
    expect(inScope(".config/app.json", custom)).toBe(true);
    expect(inScope(".config/workspace.json", custom)).toBe(false);
    expect(inScope(".obsidian/app.json", custom)).toBe(false);
  });
});

describe("scope and size cap in the engine", () => {
  const scope = (on: boolean) => (p: string) => inScope(p, on ? withConfig : base);

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

describe("configChanges", () => {
  const s = { configDir: ".obsidian", pluginDir: ".obsidian/plugins/gdrive-sync" };
  const ok = (action: string, path: string, detail?: string) => ({ action, path, ok: true, ...(detail ? { detail } : {}) });

  it("collects plugins, the enabled list, settings and themes written on this device", () => {
    const c = configChanges(
      [
        ok("download", ".obsidian/plugins/dataview/main.js"),
        ok("download", ".obsidian/plugins/dataview/manifest.json"),
        ok("download", ".obsidian/plugins/calendar/data.json"),
        ok("deleteLocal", ".obsidian/plugins/old-plugin/main.js"),
        ok("download", ".obsidian/community-plugins.json"),
        ok("conflict", ".obsidian/app.json", "kept both"),
        ok("download", ".obsidian/snippets/wide.css"),
        ok("download", "notes/a.md"),
      ],
      s,
    );
    expect([...c.plugins].sort()).toEqual(["calendar", "dataview", "old-plugin"]);
    expect([...c.pluginDataOnly]).toEqual(["calendar"]);
    expect(c).toMatchObject({ enabledList: true, settings: true, themes: true });
  });

  it("ignores uploads, failures, other vault files and this plugin", () => {
    const c = configChanges(
      [
        ok("upload", ".obsidian/plugins/dataview/main.js"),
        ok("record", ".obsidian/app.json"),
        { action: "download", path: ".obsidian/plugins/calendar/main.js", ok: false, detail: "offline" },
        ok("download", ".obsidian/plugins/gdrive-sync/main.js"),
        ok("download", "daily/note.md"),
      ],
      s,
    );
    expect(c).toEqual({ plugins: new Set(), pluginDataOnly: new Set(), enabledList: false, settings: false, themes: false });
  });

  it("counts both ends of a move", () => {
    const c = configChanges([ok("moveLocal", ".obsidian/snippets/b.css", "from .obsidian/plugins/x/styles.css")], s);
    expect([...c.plugins]).toEqual(["x"]);
    expect(c.themes).toBe(true);
  });
});

describe("plugin sync between devices", () => {
  it("syncs plugin files and the enabled list, never this plugin's tokens", async () => {
    const { mac, phone, remote } = world();
    const scope = (p: string) => inScope(p, { ...base, config: { ...NO_CONFIG_SYNC, plugins: true } });
    mac.local
      .put(".obsidian/community-plugins.json", '["gdrive-sync","dataview"]')
      .put(".obsidian/plugins/dataview/main.js", "code")
      .put(".obsidian/plugins/dataview/manifest.json", "{}")
      .put(".obsidian/plugins/gdrive-sync/data.json", "TOKENS")
      .put(".obsidian/app.json", "{}");
    await mac.syncOk({ scope });

    const result = await phone.syncOk({ scope });

    expect(remote.paths()).toEqual([
      ".obsidian/community-plugins.json",
      ".obsidian/plugins/dataview/main.js",
      ".obsidian/plugins/dataview/manifest.json",
    ]);
    const changes = configChanges(result.log, { configDir: ".obsidian", pluginDir: ".obsidian/plugins/gdrive-sync" });
    expect([...changes.plugins]).toEqual(["dataview"]);
    expect(changes.enabledList).toBe(true);
  });
});
