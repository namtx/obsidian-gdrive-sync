import { Notice } from "obsidian";
import { SyncEngine, type SyncOptions, type SyncResult } from "../core/engine";
import { mergeStringSet } from "../core/merge";
import { Manifest } from "../core/manifest";
import { DriveClient } from "../drive/client";
import { AuthExpiredError, type TokenManager } from "../drive/oauth";
import { DriveRemoteStore } from "../drive/remote";
import type GDriveSyncPlugin from "../main";
import { obsidianHttp } from "./http";
import { inScope } from "./scope";
import { SelfWriteFilter, ThrottledSaver, type Trigger } from "./sync-controller";

export interface SyncRecord {
  trigger: Trigger;
  startedAt: number;
  finishedAt: number;
  result: SyncResult | null;
  error: string | null;
}

/** Builds the engine from the plugin's stores and runs one sync. */
export class SyncRunner {
  readonly local: SelfWriteFilter;
  private manifest = new Manifest();
  private engine: SyncEngine | null = null;
  private engineFor: TokenManager | null = null;
  private saver: ThrottledSaver;
  last: SyncRecord | null = null;
  /** A plan is waiting for the user; automatic triggers skip until it is confirmed or a manual sync re-asks. */
  paused: "firstSync" | "massDelete" | null = null;
  /** Options for the next run only, e.g. the confirmation the user just gave. */
  nextOptions: Partial<SyncOptions> = {};
  /** True while a sync is running, for the status bar. */
  active = false;

  constructor(private plugin: GDriveSyncPlugin) {
    this.local = new SelfWriteFilter(plugin.localStore);
    this.saver = new ThrottledSaver(() => this.saveManifest());
  }

  private get statePath(): string {
    return `${this.plugin.pluginDir}/sync-state.json`;
  }

  async load(): Promise<void> {
    const adapter = this.plugin.app.vault.adapter;
    if (await adapter.exists(this.statePath)) this.manifest = Manifest.fromJSON(JSON.parse(await adapter.read(this.statePath)));
  }

  private async saveManifest(): Promise<void> {
    await this.plugin.app.vault.adapter.write(this.statePath, JSON.stringify(this.manifest.toJSON()));
  }

  /** One engine per signed-in session, so the Drive folder ids it caches stay valid. */
  private engineOrNull(): SyncEngine | null {
    const tokens = this.plugin.tokenManager;
    if (!tokens) return null;
    if (this.engine && this.engineFor === tokens) return this.engine;
    const remote = new DriveRemoteStore(new DriveClient(obsidianHttp, tokens), {
      rootPath: ["ObsidianSync", this.plugin.app.vault.getName()],
    });
    this.engine = new SyncEngine(this.local, remote, this.plugin.baseStore, this.manifest);
    this.engineFor = tokens;
    return this.engine;
  }

  async run(trigger: Trigger, extra: Partial<SyncOptions> = {}): Promise<SyncResult | null> {
    const manual = trigger === "manual";
    const engine = this.engineOrNull();
    if (!engine) {
      if (manual) new Notice("Google Drive Sync: sign in first (plugin settings).");
      return null;
    }
    if (this.paused && !manual) return null;
    const confirmed = this.nextOptions;
    this.nextOptions = {};
    this.active = true;
    this.plugin.onSyncStarted();
    const data = this.plugin.data;
    const renames = this.plugin.renames.snapshot();
    const scopeKey = JSON.stringify({ config: data.configSync, maxFileSizeMB: data.maxFileSizeMB });
    const record: SyncRecord = { trigger, startedAt: Date.now(), finishedAt: 0, result: null, error: null };
    try {
      const result = await engine.sync({
        device: this.plugin.deviceName,
        renameEvents: renames,
        scope: (path) => inScope(path, this.plugin.scope),
        maxFileSize: data.maxFileSizeMB * 1024 * 1024,
        commit: () => this.saver.request(),
        fullListing: scopeKey !== data.lastScope,
        // The enabled-plugins list differs per device on the first plugin sync; merge it instead of keeping both.
        customMerge: {
          matches: (path) => path === `${this.plugin.app.vault.configDir}/community-plugins.json`,
          merge: mergeStringSet,
        },
        ...confirmed,
        ...extra,
      });
      await this.saver.flush();
      if (result.status === "synced") {
        await this.plugin.renames.consumed(renames.length);
        if (data.lastScope !== scopeKey) {
          data.lastScope = scopeKey;
          await this.plugin.save();
        }
      }
      record.result = result;
      if (result.status === "synced" || result.status === "partial") {
        await this.plugin
          .applySyncedConfig(result.log)
          .catch((e) => console.error("Google Drive Sync: applying config changes failed", e));
      }
      if (result.status === "needsConfirmation") {
        this.paused = result.reason;
        this.plugin.askConfirmation(result);
      } else {
        this.paused = null;
        if (manual || result.status === "partial") new Notice(describe(result), result.status === "partial" ? 10_000 : 4_000);
      }
      return result;
    } catch (e) {
      await this.saver.flush().catch(() => {});
      record.error = e instanceof Error ? e.message : String(e);
      if (e instanceof AuthExpiredError) new Notice(`Google Drive Sync: ${record.error}`, 0);
      else if (manual) new Notice(`Google Drive Sync failed: ${record.error}`, 10_000);
      return null;
    } finally {
      record.finishedAt = Date.now();
      this.last = record;
      this.active = false;
      this.plugin.onSyncFinished();
    }
  }
}

export function describe(result: SyncResult): string {
  const s = result.summary;
  const parts = [
    s.uploads.length && `${s.uploads.length} up`,
    s.downloads.length && `${s.downloads.length} down`,
    s.moves.length && `${s.moves.length} moved`,
    s.deleteLocal.length + s.deleteRemote.length && `${s.deleteLocal.length + s.deleteRemote.length} deleted`,
    s.conflicts.length && `${s.conflicts.length} conflicts`,
    s.skipped.length && `${s.skipped.length} skipped (too large)`,
  ].filter(Boolean);
  const changes = parts.length ? parts.join(", ") : "no changes";
  switch (result.status) {
    case "synced":
      return `Google Drive Sync: ${changes}.`;
    case "partial": {
      const failed = result.log.filter((e) => !e.ok).length;
      return `Google Drive Sync: ${failed} file(s) not synced, will retry. ${changes}.`;
    }
    case "dryRun":
      return `Google Drive Sync (dry run): ${changes}.`;
    case "needsConfirmation":
      return result.reason === "firstSync"
        ? `Google Drive Sync: first sync needs confirmation (${changes}).`
        : `Google Drive Sync: paused, would delete ${s.deleteLocal.length + s.deleteRemote.length} files. Confirm to continue.`;
  }
}
