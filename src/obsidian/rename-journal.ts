import type { RenameEvent } from "../core/renames";
import type { VaultPath } from "../core/types";

/**
 * Vault renames since the last clean sync, persisted so a rename made while
 * offline or before a restart still syncs as a move rather than delete + upload.
 */
export class RenameJournal {
  constructor(
    private events: RenameEvent[],
    private save: (events: RenameEvent[]) => Promise<void>,
    /** Cap so a journal that never gets cleared cannot grow without bound. */
    private limit = 5000,
  ) {}

  async record(from: VaultPath, to: VaultPath): Promise<void> {
    if (from === to) return;
    this.events.push({ from, to });
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
    await this.save(this.events);
  }

  snapshot(): RenameEvent[] {
    return this.events.map((e) => ({ ...e }));
  }

  /** Drop the events a finished sync consumed; renames recorded during that sync stay. */
  async consumed(count: number): Promise<void> {
    if (count === 0) return;
    this.events.splice(0, count);
    await this.save(this.events);
  }
}
