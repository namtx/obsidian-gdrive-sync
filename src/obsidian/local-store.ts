import { TFile, type DataAdapter, type Vault } from "obsidian";
import type { LocalFile, LocalStore, VaultPath } from "../core/types";
import { toArrayBuffer } from "./base-store";
import { inScope, type ScopeSettings } from "./scope";

/**
 * `LocalStore` over the vault. Notes and attachments go through the Vault API
 * so open editors and the metadata cache update at once; the config folder is
 * invisible to it and goes through the adapter.
 */
export class ObsidianLocalStore implements LocalStore {
  constructor(
    private vault: Vault,
    private scope: () => ScopeSettings,
  ) {}

  private get adapter(): DataAdapter {
    return this.vault.adapter;
  }

  private isConfig(path: VaultPath): boolean {
    return path.startsWith(`${this.vault.configDir}/`);
  }

  async list(): Promise<LocalFile[]> {
    const s = this.scope();
    const files: LocalFile[] = this.vault
      .getFiles()
      .filter((f) => inScope(f.path, s))
      .map((f) => ({ path: f.path, size: f.stat.size, mtime: f.stat.mtime }));
    if (s.config.plugins || s.config.settings || s.config.themes) await this.walkConfig(this.vault.configDir, s, files);
    return files;
  }

  private async walkConfig(dir: string, s: ScopeSettings, out: LocalFile[]) {
    const { files, folders } = await this.adapter.list(dir);
    for (const path of files) {
      if (!inScope(path, s)) continue;
      const stat = await this.adapter.stat(path);
      if (stat?.type === "file") out.push({ path, size: stat.size, mtime: stat.mtime });
    }
    // Skip whole excluded subtrees (this plugin's folder) without listing them.
    for (const folder of folders) if (inScope(`${folder}/x`, s)) await this.walkConfig(folder, s, out);
  }

  async exists(path: VaultPath): Promise<boolean> {
    return this.adapter.exists(path);
  }

  async read(path: VaultPath): Promise<Uint8Array> {
    return new Uint8Array(await this.adapter.readBinary(path));
  }

  async write(path: VaultPath, data: Uint8Array): Promise<void> {
    await this.ensureParent(path);
    if (this.isConfig(path)) return this.adapter.writeBinary(path, toArrayBuffer(data));
    const existing = this.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.vault.modifyBinary(existing, toArrayBuffer(data));
    else if (existing) throw new Error(`${path} is a folder`);
    else await this.vault.createBinary(path, toArrayBuffer(data));
  }

  /** To the system trash, or the vault's `.trash` where there is none (iOS): always recoverable. */
  async delete(path: VaultPath): Promise<void> {
    if (this.isConfig(path)) {
      if (!(await this.adapter.trashSystem(path))) await this.adapter.trashLocal(path);
      return;
    }
    const file = this.vault.getAbstractFileByPath(path);
    if (file) await this.vault.trash(file, true);
  }

  /**
   * Plain `Vault.rename`, not `FileManager.renameFile`: the other device already
   * rewrote links, and those edits arrive as their own content changes.
   */
  async rename(from: VaultPath, to: VaultPath): Promise<void> {
    await this.ensureParent(to);
    if (this.isConfig(from)) return this.adapter.rename(from, to);
    const file = this.vault.getAbstractFileByPath(from);
    if (!file) throw new Error(`no such file ${from}`);
    await this.vault.rename(file, to);
  }

  private async ensureParent(path: VaultPath) {
    const parts = path.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (await this.adapter.exists(dir)) continue;
      if (this.isConfig(path)) await this.adapter.mkdir(dir);
      else await this.vault.createFolder(dir);
    }
  }
}
