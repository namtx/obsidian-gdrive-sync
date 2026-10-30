import type { DataAdapter } from "obsidian";
import type { BaseStore } from "../core/base";
import { sha256 } from "../core/hash";
import type { VaultPath } from "../core/types";

/**
 * Merge bases as files in the plugin folder, one per synced path, named by a
 * hash of the path so nested and unusual paths need no folder structure.
 */
export class AdapterBaseStore implements BaseStore {
  constructor(
    private adapter: DataAdapter,
    /** e.g. `.obsidian/plugins/gdrive-sync/bases`, never synced. */
    private dir: string,
  ) {}

  async get(path: VaultPath): Promise<Uint8Array | undefined> {
    const file = await this.file(path);
    if (!(await this.adapter.exists(file))) return undefined;
    return new Uint8Array(await this.adapter.readBinary(file));
  }

  async set(path: VaultPath, data: Uint8Array): Promise<void> {
    if (!(await this.adapter.exists(this.dir))) await this.adapter.mkdir(this.dir);
    await this.adapter.writeBinary(await this.file(path), toArrayBuffer(data));
  }

  async delete(path: VaultPath): Promise<void> {
    const file = await this.file(path);
    if (await this.adapter.exists(file)) await this.adapter.remove(file);
  }

  private async file(path: VaultPath): Promise<string> {
    return `${this.dir}/${await sha256(new TextEncoder().encode(path))}`;
  }
}

export function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}
