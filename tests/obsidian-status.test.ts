import { describe, expect, it } from "vitest";
import type { PlanSummary } from "../src/core/engine";
import { ago, confirmationTitle, statusText, summarySections } from "../src/obsidian/status";

const empty: PlanSummary = {
  uploads: [],
  downloads: [],
  unchanged: [],
  conflicts: [],
  deleteLocal: [],
  deleteRemote: [],
  moves: [],
  skipped: [],
};

describe("status text", () => {
  it("describes each state", () => {
    const now = 10 * 60_000;
    expect(statusText({ kind: "signedOut" }, now)).toBe("Drive: signed out");
    expect(statusText({ kind: "syncing" }, now)).toBe("Drive: syncing…");
    expect(statusText({ kind: "paused", reason: "firstSync" }, now)).toBe("Drive: confirm first sync");
    expect(statusText({ kind: "paused", reason: "massDelete" }, now)).toBe("Drive: confirm deletes");
    expect(statusText({ kind: "partial", failed: 2, at: now }, now)).toBe("Drive: 2 not synced");
    expect(statusText({ kind: "synced", at: now - 3 * 60_000, skipped: 0 }, now)).toBe("Drive: synced 3 min ago");
    expect(statusText({ kind: "synced", at: now, skipped: 1 }, now)).toBe("Drive: synced just now (1 skipped)");
    expect(statusText({ kind: "error", message: "x", at: now - 2 * 3_600_000 }, now)).toBe("Drive: sync failed 2 h ago");
  });

  it("formats relative times", () => {
    expect(ago(0, 59_000)).toBe("just now");
    expect(ago(0, 26 * 3_600_000)).toBe("1 d ago");
  });
});

describe("confirmation content", () => {
  it("lists only non-empty sections, with moves shown as from → to", () => {
    const sections = summarySections({
      ...empty,
      uploads: ["a.md"],
      conflicts: ["c.md"],
      moves: [{ side: "remote", from: "x.md", to: "y.md", remoteId: "1", via: "event" }],
    });
    expect(sections).toEqual([
      { label: "Upload to Drive", paths: ["a.md"] },
      { label: "Conflicts (both versions kept)", paths: ["c.md"] },
      { label: "Move", paths: ["x.md → y.md"] },
    ]);
  });

  it("titles mass deletes with the count", () => {
    const summary = { ...empty, deleteLocal: ["a"], deleteRemote: ["b", "c"] };
    expect(confirmationTitle({ status: "needsConfirmation", reason: "massDelete", summary, log: [] })).toBe(
      "Confirm deleting 3 files",
    );
    expect(confirmationTitle({ status: "needsConfirmation", reason: "firstSync", summary, log: [] })).toBe(
      "Confirm first sync",
    );
  });
});
