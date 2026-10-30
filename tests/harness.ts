import { MemoryBaseStore } from "../src/core/base";
import { SyncEngine, type SyncOptions, type SyncResult } from "../src/core/engine";
import { Manifest } from "../src/core/manifest";
import { Clock, FakeLocal, FakeRemote } from "./fakes";

export const DAY = new Date("2026-10-30T12:00:00Z");

/** One device: its own vault, base cache and persisted manifest, sharing a remote. */
export class Device {
  local: FakeLocal;
  base = new MemoryBaseStore();
  /** What `commit` last persisted, as a device would write to data.json. */
  saved: ReturnType<Manifest["toJSON"]> | null = null;
  engine: SyncEngine;

  constructor(
    public name: string,
    public remote: FakeRemote,
    clock: Clock,
  ) {
    this.local = new FakeLocal(clock);
    this.engine = new SyncEngine(this.local, remote, this.base, new Manifest());
  }

  get manifest() {
    return this.engine.manifest;
  }

  sync(options: Partial<SyncOptions> = {}): Promise<SyncResult> {
    return this.engine.sync({
      device: this.name,
      now: () => DAY,
      commit: async (m) => {
        this.saved = m.toJSON();
      },
      ...options,
    });
  }

  /** Simulate an app restart: reload the engine from the last persisted manifest. */
  restart() {
    this.engine = new SyncEngine(this.local, this.remote, this.base, Manifest.fromJSON(this.saved));
  }

  /** Sync once, confirming first sync, and expect a clean result. */
  async syncOk(options: Partial<SyncOptions> = {}) {
    const result = await this.sync({ confirmFirstSync: true, ...options });
    if (result.status !== "synced") throw new Error(`${this.name}: ${result.status} ${JSON.stringify(result.log)}`);
    return result;
  }
}

export function world() {
  const clock = new Clock();
  const remote = new FakeRemote(clock);
  return {
    clock,
    remote,
    mac: new Device("Mac", remote, clock),
    phone: new Device("iPhone", remote, clock),
  };
}
