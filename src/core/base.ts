import type { VaultPath } from "./types";

/**
 * Last-synced content of mergeable files, kept on this device as the base for
 * three-way merges. Drive revisions expire, so the base cannot live there.
 */
export interface BaseStore {
  get(path: VaultPath): Promise<Uint8Array | undefined>;
  set(path: VaultPath, data: Uint8Array): Promise<void>;
  delete(path: VaultPath): Promise<void>;
}

export class MemoryBaseStore implements BaseStore {
  files = new Map<VaultPath, Uint8Array>();
  async get(path: VaultPath) {
    return this.files.get(path);
  }
  async set(path: VaultPath, data: Uint8Array) {
    this.files.set(path, data);
  }
  async delete(path: VaultPath) {
    this.files.delete(path);
  }
}
