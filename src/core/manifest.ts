import type { Hash, VaultPath } from "./types";

/** What this device last agreed with the remote about one file. */
export interface ManifestEntry {
  path: VaultPath;
  hash: Hash;
  remoteId: string;
  revision: string;
}

export interface ManifestData {
  version: 1;
  cursor: string | null;
  entries: ManifestEntry[];
}

/** Per-device record of the last synced state. Never synced itself. */
export class Manifest {
  cursor: string | null = null;
  private byPath = new Map<VaultPath, ManifestEntry>();

  static fromJSON(data: ManifestData | null | undefined): Manifest {
    const manifest = new Manifest();
    if (!data) return manifest;
    if (data.version !== 1) throw new Error(`Unsupported manifest version ${data.version}`);
    manifest.cursor = data.cursor;
    for (const entry of data.entries) manifest.byPath.set(entry.path, { ...entry });
    return manifest;
  }

  toJSON(): ManifestData {
    return {
      version: 1,
      cursor: this.cursor,
      entries: [...this.byPath.values()].map((e) => ({ ...e })),
    };
  }

  get(path: VaultPath): ManifestEntry | undefined {
    return this.byPath.get(path);
  }

  findByRemoteId(id: string): ManifestEntry | undefined {
    for (const entry of this.byPath.values()) if (entry.remoteId === id) return entry;
    return undefined;
  }

  set(entry: ManifestEntry): void {
    this.byPath.set(entry.path, { ...entry });
  }

  delete(path: VaultPath): void {
    this.byPath.delete(path);
  }

  entries(): ManifestEntry[] {
    return [...this.byPath.values()];
  }

  get size(): number {
    return this.byPath.size;
  }
}
