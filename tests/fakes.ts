import { sha256 } from "../src/core/hash";
import {
  RemoteChangedError,
  type Hash,
  type LocalFile,
  LocalStore,
  type RemoteChange,
  type RemoteDelta,
  type RemoteFile,
  type RemoteSnapshot,
  type RemoteStore,
  type VaultPath,
} from "../src/core/types";

export const text = (s: string) => new TextEncoder().encode(s);
export const str = (b: Uint8Array) => new TextDecoder().decode(b);

/** Monotonic fake clock shared by stores so mtimes are ordered and deterministic. */
export class Clock {
  constructor(public now = 1_000) {}
  tick(): number {
    return ++this.now;
  }
}

export class FakeLocal implements LocalStore {
  files = new Map<VaultPath, { data: Uint8Array; mtime: number }>();
  /** Paths whose next operation should throw, to simulate failures. */
  failOn = new Set<VaultPath>();

  constructor(private clock = new Clock()) {}

  put(path: VaultPath, content: string | Uint8Array): this {
    const data = typeof content === "string" ? text(content) : content;
    this.files.set(path, { data, mtime: this.clock.tick() });
    return this;
  }

  text(path: VaultPath): string | undefined {
    const f = this.files.get(path);
    return f && str(f.data);
  }

  async list(): Promise<LocalFile[]> {
    return [...this.files].map(([path, f]) => ({ path, size: f.data.length, mtime: f.mtime }));
  }

  async exists(path: VaultPath): Promise<boolean> {
    return this.files.has(path);
  }

  async read(path: VaultPath): Promise<Uint8Array> {
    this.check(path);
    const f = this.files.get(path);
    if (!f) throw new Error(`local: no such file ${path}`);
    return f.data;
  }

  async write(path: VaultPath, data: Uint8Array): Promise<void> {
    this.check(path);
    this.files.set(path, { data, mtime: this.clock.tick() });
  }

  async delete(path: VaultPath): Promise<void> {
    this.check(path);
    this.files.delete(path);
  }

  async rename(from: VaultPath, to: VaultPath): Promise<void> {
    this.check(from);
    const f = this.files.get(from);
    if (!f) throw new Error(`local: no such file ${from}`);
    this.files.delete(from);
    this.files.set(to, f);
  }

  private check(path: VaultPath) {
    if (this.failOn.has(path)) throw new Error(`local: injected failure on ${path}`);
  }
}

interface StoredRemote {
  meta: RemoteFile;
  data: Uint8Array;
}

export class FakeRemote implements RemoteStore {
  files = new Map<string, StoredRemote>();
  trashed = new Map<string, StoredRemote>();
  /** Every operation, for asserting no redundant transfers. */
  calls: string[] = [];
  failOn = new Set<VaultPath>();
  private log: RemoteChange[] = [];
  /** Hide this many of the newest changes from the feed, simulating Drive's change-feed lag. */
  lag = 0;
  /** Cursors older than this sequence number are rejected, simulating expiry. */
  oldestValidCursor = 0;
  private nextId = 1;
  private nextRev = 1;

  constructor(private clock = new Clock()) {}

  /** Seed or overwrite a file as if another device had uploaded it. */
  async put(path: VaultPath, content: string | Uint8Array): Promise<RemoteFile> {
    const data = typeof content === "string" ? text(content) : content;
    const existing = this.byPath(path);
    return { ...(await this.store(path, data, existing?.meta.id)).meta };
  }

  /** Simulate another device trashing a file. */
  remove(path: VaultPath): void {
    const f = this.byPath(path);
    if (!f) throw new Error(`remote: no such file ${path}`);
    this.files.delete(f.meta.id);
    this.trashed.set(f.meta.id, f);
    this.log.push({ kind: "removed", id: f.meta.id });
  }

  byPath(path: VaultPath): StoredRemote | undefined {
    for (const f of this.files.values()) if (f.meta.path === path) return f;
    return undefined;
  }

  text(path: VaultPath): string | undefined {
    const f = this.byPath(path);
    return f && str(f.data);
  }

  paths(): VaultPath[] {
    return [...this.files.values()].map((f) => f.meta.path).sort();
  }

  async listAll(): Promise<RemoteSnapshot> {
    this.calls.push("listAll");
    return { files: [...this.files.values()].map((f) => ({ ...f.meta })), cursor: String(this.log.length) };
  }

  async changesSince(cursor: string): Promise<RemoteDelta | null> {
    this.calls.push(`changesSince ${cursor}`);
    const seq = Number(cursor);
    if (!Number.isInteger(seq) || seq < this.oldestValidCursor || seq > this.log.length) return null;
    const visible = Math.max(seq, this.log.length - this.lag);
    return { changes: this.log.slice(seq, visible).map((c) => structuredClone(c)), cursor: String(visible) };
  }

  async download(id: string): Promise<Uint8Array> {
    const f = this.files.get(id);
    if (!f) throw new Error(`remote: no such id ${id}`);
    this.calls.push(`download ${f.meta.path}`);
    this.check(f.meta.path);
    return f.data;
  }

  async upload(path: VaultPath, data: Uint8Array, id?: string, expectedHash?: Hash): Promise<RemoteFile> {
    this.calls.push(`upload ${path}`);
    this.check(path);
    if (id !== undefined && !this.files.has(id)) throw new Error(`remote: no such id ${id}`);
    if (id !== undefined && expectedHash !== undefined && this.files.get(id)!.meta.hash !== expectedHash)
      throw new RemoteChangedError(id);
    return { ...(await this.store(path, data, id)).meta };
  }

  async move(id: string, to: VaultPath): Promise<RemoteFile> {
    const f = this.files.get(id);
    if (!f) throw new Error(`remote: no such id ${id}`);
    this.calls.push(`move ${f.meta.path} -> ${to}`);
    this.check(to);
    f.meta = { ...f.meta, path: to };
    this.log.push({ kind: "upsert", file: { ...f.meta } });
    return { ...f.meta };
  }

  async trash(id: string, expectedHash?: Hash): Promise<void> {
    const f = this.files.get(id);
    if (!f) throw new Error(`remote: no such id ${id}`);
    if (expectedHash !== undefined && f.meta.hash !== expectedHash) throw new RemoteChangedError(id);
    this.calls.push(`trash ${f.meta.path}`);
    this.check(f.meta.path);
    this.files.delete(id);
    this.trashed.set(id, f);
    this.log.push({ kind: "removed", id });
  }

  private async store(path: VaultPath, data: Uint8Array, id?: string): Promise<StoredRemote> {
    const meta: RemoteFile = {
      id: id ?? `id${this.nextId++}`,
      path,
      hash: await sha256(data),
      revision: `r${this.nextRev++}`,
      size: data.length,
      mtime: this.clock.tick(),
    };
    const stored = { meta, data };
    this.files.set(meta.id, stored);
    this.log.push({ kind: "upsert", file: { ...meta } });
    return stored;
  }

  private check(path: VaultPath) {
    if (this.failOn.has(path)) throw new Error(`remote: injected failure on ${path}`);
  }
}
