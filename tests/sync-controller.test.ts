import { describe, expect, it } from "vitest";
import { SelfWriteFilter, SyncController, ThrottledSaver, type Timers, type Trigger } from "../src/obsidian/sync-controller";
import { FakeLocal, text } from "./fakes";

class FakeTimers implements Timers {
  t = 0;
  private tasks: Array<{ at: number; fn: () => void; id: number }> = [];
  private nextId = 1;
  setTimeout(fn: () => void, ms: number) {
    const id = this.nextId++;
    this.tasks.push({ at: this.t + ms, fn, id });
    return id;
  }
  clearTimeout(h: unknown) {
    this.tasks = this.tasks.filter((x) => x.id !== h);
  }
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
    const due = this.tasks.filter((x) => x.at <= this.t);
    this.tasks = this.tasks.filter((x) => x.at > this.t);
    for (const x of due) x.fn();
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("SyncController", () => {
  it("never runs two syncs at once and collapses triggers that arrive mid-sync into one follow-up", async () => {
    const runs: Trigger[] = [];
    let active = 0;
    let maxActive = 0;
    const gates = [deferred(), deferred()];
    const controller = new SyncController(async (t) => {
      runs.push(t);
      active++;
      maxActive = Math.max(maxActive, active);
      await gates[runs.length - 1]!.promise;
      active--;
    }, new FakeTimers());

    const first = controller.trigger("startup");
    const a = controller.trigger("interval");
    const b = controller.trigger("edit");
    const c = controller.trigger("manual");
    await tick();
    expect(runs).toEqual(["startup"]);

    gates[0]!.resolve();
    await tick();
    expect(runs).toEqual(["startup", "manual"]);
    gates[1]!.resolve();
    await Promise.all([first, a, b, c]);

    expect(runs).toEqual(["startup", "manual"]);
    expect(maxActive).toBe(1);
    expect(controller.isRunning).toBe(false);
  });

  it("keeps working after a failed sync", async () => {
    const runs: Trigger[] = [];
    const controller = new SyncController(async (t) => {
      runs.push(t);
      if (runs.length === 1) throw new Error("offline");
    }, new FakeTimers());
    await expect(controller.trigger("manual")).rejects.toThrow("offline");
    await controller.trigger("manual");
    expect(runs).toEqual(["manual", "manual"]);
  });

  it("debounces edits into one sync after a quiet period", async () => {
    const timers = new FakeTimers();
    const runs: Trigger[] = [];
    const controller = new SyncController(async (t) => void runs.push(t), timers, 10_000);

    controller.noteEdit();
    timers.advance(6_000);
    controller.noteEdit();
    timers.advance(6_000);
    expect(runs).toEqual([]);
    timers.advance(4_000);
    await tick();
    expect(runs).toEqual(["edit"]);
  });
});

describe("SelfWriteFilter", () => {
  it("recognises the sync's own writes for a short window", async () => {
    const timers = new FakeTimers();
    const local = new FakeLocal().put("a.md", "a");
    const filter = new SelfWriteFilter(local, timers, 5_000);

    await filter.write("b.md", text("b"));
    await filter.rename("a.md", "c.md");
    expect(["a.md", "b.md", "c.md"].map((p) => filter.isSelf(p))).toEqual([true, true, true]);
    expect(filter.isSelf("user-edit.md")).toBe(false);

    timers.advance(6_000);
    expect(filter.isSelf("b.md")).toBe(false);
  });
});

describe("ThrottledSaver", () => {
  it("saves at most once per interval and flushes the rest at the end", async () => {
    const timers = new FakeTimers();
    let saves = 0;
    const saver = new ThrottledSaver(async () => void saves++, timers, 2_000);

    timers.t = 10_000;
    await saver.request();
    await saver.request();
    await saver.request();
    expect(saves).toBe(1);
    timers.advance(2_500);
    await saver.request();
    expect(saves).toBe(2);
    await saver.request();
    await saver.flush();
    expect(saves).toBe(3);
    await saver.flush();
    expect(saves).toBe(3);
  });
});
