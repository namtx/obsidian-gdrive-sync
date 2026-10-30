import type { LocalFile, LocalStore, VaultPath } from "../core/types";

export type Trigger = "startup" | "resume" | "manual" | "interval" | "edit";

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (h) => window.clearTimeout(h as number),
  now: () => Date.now(),
};

/**
 * Runs one sync at a time. Triggers that arrive mid-sync collapse into a
 * single follow-up run, so a burst of edits never stacks syncs.
 */
export class SyncController {
  private running: Promise<void> | null = null;
  private queued: Trigger | null = null;
  private editTimer: unknown = null;
  lastFinished = 0;

  constructor(
    private runSync: (trigger: Trigger) => Promise<void>,
    private timers: Timers = realTimers,
    /** Quiet period after the last edit before syncing. */
    public editDebounceMs = 10_000,
  ) {}

  get isRunning(): boolean {
    return this.running !== null;
  }

  /** Start a sync now, or once the current one finishes. Resolves when the requested work is done. */
  async trigger(trigger: Trigger): Promise<void> {
    if (this.running) {
      // A manual request outranks a queued automatic one, so its notices are shown.
      if (this.queued === null || trigger === "manual") this.queued = trigger;
      await this.running;
      // The follow-up run started by whoever finished first covers this request.
      if (this.running) await this.running;
      return;
    }
    this.running = this.loop(trigger);
    await this.running;
  }

  private async loop(first: Trigger) {
    let next: Trigger | null = first;
    try {
      while (next) {
        this.queued = null;
        try {
          await this.runSync(next);
        } finally {
          this.lastFinished = this.timers.now();
        }
        next = this.queued;
      }
    } finally {
      this.running = null;
    }
  }

  /** A local edit: sync once edits have been quiet for the debounce period. */
  noteEdit(): void {
    if (this.editTimer !== null) this.timers.clearTimeout(this.editTimer);
    this.editTimer = this.timers.setTimeout(() => {
      this.editTimer = null;
      void this.trigger("edit").catch(() => {});
    }, this.editDebounceMs);
  }

  dispose(): void {
    if (this.editTimer !== null) this.timers.clearTimeout(this.editTimer);
    this.editTimer = null;
  }
}

/**
 * Wraps the vault store and remembers what the sync itself just wrote, so the
 * resulting vault events are not mistaken for user edits and do not trigger
 * another sync.
 */
export class SelfWriteFilter implements LocalStore {
  private written = new Map<VaultPath, number>();

  constructor(
    private inner: LocalStore,
    private timers: Pick<Timers, "now"> = realTimers,
    private windowMs = 5_000,
  ) {}

  /** True if `path` was written, deleted or renamed by the sync within the window. */
  isSelf(path: VaultPath): boolean {
    const at = this.written.get(path);
    if (at === undefined) return false;
    if (this.timers.now() - at > this.windowMs) {
      this.written.delete(path);
      return false;
    }
    return true;
  }

  private mark(...paths: VaultPath[]) {
    const now = this.timers.now();
    for (const p of paths) this.written.set(p, now);
  }

  list(): Promise<LocalFile[]> {
    return this.inner.list();
  }
  exists(path: VaultPath): Promise<boolean> {
    return this.inner.exists(path);
  }
  read(path: VaultPath): Promise<Uint8Array> {
    return this.inner.read(path);
  }
  async write(path: VaultPath, data: Uint8Array): Promise<void> {
    this.mark(path);
    await this.inner.write(path, data);
    this.mark(path);
  }
  async delete(path: VaultPath): Promise<void> {
    this.mark(path);
    await this.inner.delete(path);
    this.mark(path);
  }
  async rename(from: VaultPath, to: VaultPath): Promise<void> {
    this.mark(from, to);
    await this.inner.rename(from, to);
    this.mark(from, to);
  }
}

/**
 * Coalesces frequent saves: at most one write per interval, plus a final
 * `flush()`. Losing the last few saves to a crash is safe for the manifest,
 * because the next run finds matching hashes and records them again.
 */
export class ThrottledSaver {
  private dirty = false;
  private lastSave = 0;
  private saving: Promise<void> | null = null;

  constructor(
    private save: () => Promise<void>,
    private timers: Pick<Timers, "now"> = realTimers,
    private intervalMs = 2_000,
  ) {}

  async request(): Promise<void> {
    this.dirty = true;
    if (this.timers.now() - this.lastSave >= this.intervalMs) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.saving) await this.saving;
    if (!this.dirty) return;
    this.dirty = false;
    this.lastSave = this.timers.now();
    this.saving = this.save().finally(() => (this.saving = null));
    await this.saving;
  }
}
