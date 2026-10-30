import type { BaseStore } from "./base";
import { sha256 } from "./hash";
import { Manifest } from "./manifest";
import { conflictPath, isMergeable, mergeText } from "./merge";
import { plan, type Action, type LocalState } from "./plan";
import { detectRenames, type Move, type RenameEvent } from "./renames";
import type { LocalStore, RemoteDelta, RemoteFile, RemoteStore, VaultPath } from "./types";

export type RetryPolicy = <T>(op: () => Promise<T>) => Promise<T>;

export interface DeleteGuard {
  /** Pause when deletes exceed this fraction of the vault. */
  maxFraction: number;
  /** Pause when deletes exceed this many files. */
  maxCount: number;
}

export const DEFAULT_DELETE_GUARD: DeleteGuard = { maxFraction: 0.2, maxCount: 50 };

export interface SyncOptions {
  /** Shown in conflict file names. */
  device: string;
  now?: () => Date;
  /** Vault renames since the last successful sync. */
  renameEvents?: RenameEvent[];
  /** Plan and summarise without changing anything. */
  dryRun?: boolean;
  /** The user has seen the first-sync summary and agreed. */
  confirmFirstSync?: boolean;
  /** The user has agreed to a mass delete. */
  confirmDeletes?: boolean;
  deleteGuard?: DeleteGuard;
  /** Paths outside the sync scope are ignored on both sides, as if they did not exist. */
  scope?: (path: VaultPath) => boolean;
  /** Files larger than this (on either side) are left alone and listed in `summary.skipped`. */
  maxFileSize?: number;
  /** Wraps each action; transient failures can be retried with backoff here. */
  retry?: RetryPolicy;
  /** Persist the manifest. Called after every action that changed it. */
  commit?: (manifest: Manifest) => Promise<void>;
  /** Format-aware merges for specific files, tried before the generic conflict handling. */
  customMerge?: CustomMerge;
}

export interface CustomMerge {
  matches(path: VaultPath): boolean;
  /** Merged content, or null to fall back to the generic handling. `base` is absent on a first sync. */
  merge(local: Uint8Array, base: Uint8Array | undefined, remote: Uint8Array): Uint8Array | null;
}

export interface PlanSummary {
  uploads: VaultPath[];
  downloads: VaultPath[];
  /** Same content on both sides; recorded without transfer. */
  unchanged: VaultPath[];
  conflicts: VaultPath[];
  deleteLocal: VaultPath[];
  deleteRemote: VaultPath[];
  moves: Move[];
  /** Over the size cap; neither transferred nor deleted. */
  skipped: VaultPath[];
}

export interface LogEntry {
  action: string;
  path: VaultPath;
  ok: boolean;
  detail?: string;
}

export type SyncResult =
  | { status: "synced" | "partial" | "dryRun"; summary: PlanSummary; log: LogEntry[] }
  | { status: "needsConfirmation"; reason: "firstSync" | "massDelete"; summary: PlanSummary; log: LogEntry[] };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class SyncEngine {
  private customMerge: CustomMerge | undefined;

  constructor(
    private local: LocalStore,
    private remote: RemoteStore,
    private base: BaseStore,
    public manifest: Manifest,
  ) {}

  async sync(options: SyncOptions): Promise<SyncResult> {
    const inScope = options.scope ?? (() => true);
    const maxSize = options.maxFileSize ?? Infinity;
    const retry: RetryPolicy = options.retry ?? ((op) => op());
    const commit = options.commit ?? (async () => {});
    const now = options.now ?? (() => new Date());
    const guard = options.deleteGuard ?? DEFAULT_DELETE_GUARD;
    const firstSync = this.manifest.cursor === null;
    this.customMerge = options.customMerge;
    const log: LogEntry[] = [];
    // Oversized on either side: the path is left alone everywhere, so it can never look deleted.
    const oversized = new Set<VaultPath>();

    const localFiles = (await this.local.list()).filter((f) => inScope(f.path));
    for (const f of localFiles) if (f.size > maxSize) oversized.add(f.path);
    const { files, cursor } = await this.remoteView();
    const remoteFiles = files.filter((f) => inScope(f.path));
    for (const f of remoteFiles) if (f.size > maxSize) oversized.add(f.path);
    const ignored = (path: VaultPath) => !inScope(path) || oversized.has(path);

    const local = new Map<VaultPath, LocalState>();
    for (const f of localFiles) {
      if (oversized.has(f.path)) continue;
      local.set(f.path, { path: f.path, hash: await sha256(await this.local.read(f.path)), mtime: f.mtime });
    }
    const remote = new Map<VaultPath, RemoteFile>();
    for (const f of remoteFiles) if (!oversized.has(f.path)) remote.set(f.path, f);
    // Manifest entries for ignored paths (e.g. `.obsidian/` after turning config sync off) must not read as deletes.
    const scoped = Manifest.fromJSON(this.manifest.toJSON());
    for (const e of scoped.entries()) if (ignored(e.path)) scoped.delete(e.path);

    const moves = firstSync ? [] : detectRenames(local, remote, scoped, options.renameEvents);
    const movedLocal = applyMovesToLocal(local, moves);
    const actions = plan(movedLocal, applyMovesToRemote(remote, moves), applyMovesToManifest(scoped, moves));
    const summary = summarize(actions, moves, [...oversized].sort());

    if (firstSync && !options.confirmFirstSync && !options.dryRun)
      return { status: "needsConfirmation", reason: "firstSync", summary, log };
    const deletes = summary.deleteLocal.length + summary.deleteRemote.length;
    const vaultSize = Math.max(this.manifest.size, local.size);
    if (deletes > 0 && (deletes > guard.maxCount || deletes > guard.maxFraction * vaultSize) && !options.confirmDeletes && !options.dryRun)
      return { status: "needsConfirmation", reason: "massDelete", summary, log };
    if (options.dryRun) return { status: "dryRun", summary, log };

    const blocked = new Set<VaultPath>();
    let failed = false;
    const run = async (name: string, path: VaultPath, op: () => Promise<string | void>) => {
      try {
        const detail = await retry(op);
        log.push({ action: name, path, ok: true, ...(detail ? { detail } : {}) });
        return true;
      } catch (e) {
        failed = true;
        log.push({ action: name, path, ok: false, detail: e instanceof Error ? e.message : String(e) });
        return false;
      }
    };

    for (const move of moves) {
      const ok = await run(move.side === "remote" ? "moveRemote" : "moveLocal", move.to, async () => {
        await this.applyMove(move);
        await commit(this.manifest);
        return `from ${move.from}`;
      });
      if (!ok) blocked.add(move.from).add(move.to);
    }

    const ctx: ActionContext = { local: movedLocal, remote, device: options.device, now, reserved: new Set(), commit };
    for (const action of actions) {
      if (blocked.has(action.path)) continue;
      await run(action.type, action.path, async () => {
        const detail = await this.execute(action, ctx);
        await commit(this.manifest);
        return detail;
      });
    }

    // Only advance the cursor once everything applied, so a retry sees the same remote changes again.
    if (!failed) {
      this.manifest.cursor = cursor;
      await commit(this.manifest);
    }
    return { status: failed ? "partial" : "synced", summary, log };
  }

  /** Remote state as of now: the manifest plus Drive changes since the stored cursor. */
  private async remoteView(): Promise<{ files: RemoteFile[]; cursor: string }> {
    const delta: RemoteDelta | null = this.manifest.cursor === null ? null : await this.remote.changesSince(this.manifest.cursor);
    if (!delta) return this.remote.listAll();
    const byId = new Map<string, RemoteFile>();
    for (const e of this.manifest.entries())
      byId.set(e.remoteId, { id: e.remoteId, path: e.path, hash: e.hash, revision: e.revision, size: 0, mtime: 0 });
    for (const change of delta.changes) {
      if (change.kind === "removed") byId.delete(change.id);
      else byId.set(change.file.id, change.file);
    }
    return { files: [...byId.values()], cursor: delta.cursor };
  }

  private async applyMove(move: Move) {
    const entry = this.manifest.get(move.from)!;
    if (move.side === "remote") {
      const moved = await this.remote.move(move.remoteId, move.to);
      this.manifest.set({ ...entry, path: move.to, revision: moved.revision });
    } else {
      await this.local.rename(move.from, move.to);
      this.manifest.set({ ...entry, path: move.to });
    }
    this.manifest.delete(move.from);
    const base = await this.base.get(move.from);
    if (base) {
      await this.base.set(move.to, base);
      await this.base.delete(move.from);
    }
  }

  private async execute(action: Action, ctx: ActionContext): Promise<string | void> {
    switch (action.type) {
      case "upload": {
        const data = await this.local.read(action.path);
        await this.recordRemote(await this.remote.upload(action.path, data, action.remoteId, action.expectedHash), data);
        return;
      }
      case "download": {
        const data = await this.remote.download(action.remote.id);
        await this.assertLocalUnchanged(action.path, ctx.local.get(action.path)?.hash);
        await this.writeLocal(action.remote, data);
        return;
      }
      case "record": {
        await this.recordRemote(action.remote, await this.local.read(action.path));
        return;
      }
      case "deleteRemote": {
        await this.remote.trash(action.remoteId, action.expectedHash);
        await this.forget(action.path);
        return "moved to Drive trash";
      }
      case "deleteLocal": {
        await this.assertLocalUnchanged(action.path, ctx.local.get(action.path)?.hash);
        await this.local.delete(action.path);
        await this.forget(action.path);
        return;
      }
      case "forget":
        await this.forget(action.path);
        return;
      case "conflict":
        return this.resolveConflict(action, ctx);
    }
  }

  private async resolveConflict(action: Extract<Action, { type: "conflict" }>, ctx: ActionContext): Promise<string> {
    const { path, base } = action;
    const localData = await this.local.read(path);
    if (this.customMerge?.matches(path)) {
      const remoteData = await this.remote.download(action.remote.id);
      const baseData = base ? await this.base.get(path) : undefined;
      const validBase = baseData && (await sha256(baseData)) === base?.hash ? baseData : undefined;
      const merged = this.customMerge.merge(localData, validBase, remoteData);
      if (merged) {
        await this.assertLocalUnchanged(path, action.local.hash);
        await this.local.write(path, merged);
        await this.recordRemote(await this.remote.upload(path, merged, action.remote.id, action.remote.hash), merged);
        return "merged";
      }
    }
    if (base && isMergeable(path)) {
      const baseData = await this.base.get(path);
      if (baseData && (await sha256(baseData)) === base.hash) {
        const remoteData = await this.remote.download(action.remote.id);
        const merged = mergeText(decoder.decode(localData), decoder.decode(baseData), decoder.decode(remoteData));
        if (merged !== null) {
          const data = encoder.encode(merged);
          await this.assertLocalUnchanged(path, action.local.hash);
          await this.local.write(path, data);
          await this.recordRemote(await this.remote.upload(path, data, action.remote.id, action.remote.hash), data);
          return "merged";
        }
      }
    }

    // Binaries with a known base: last writer wins. The remote loser stays in Drive's revision history.
    if (base && !isMergeable(path) && action.local.mtime >= action.remote.mtime) {
      await this.recordRemote(await this.remote.upload(path, localData, action.remote.id, action.remote.hash), localData);
      return "kept local (newer)";
    }

    // Keep both: this device's version moves to a conflict copy, the remote version takes the path.
    const taken = (p: VaultPath) =>
      ctx.reserved.has(p) ||
      ((ctx.local.has(p) || ctx.remote.has(p) || !!this.manifest.get(p)) && ctx.local.get(p)?.hash !== action.local.hash);
    const copy = conflictPath(path, ctx.device, ctx.now(), taken);
    ctx.reserved.add(copy);
    await this.local.write(copy, localData);
    const existing = this.manifest.get(copy);
    if (existing?.hash !== action.local.hash) {
      const copyId = existing?.remoteId ?? ctx.remote.get(copy)?.id;
      const copyHash = existing?.hash ?? ctx.remote.get(copy)?.hash;
      await this.recordRemote(await this.remote.upload(copy, localData, copyId, copyHash), localData);
    }
    await ctx.commit(this.manifest);
    const remoteData = await this.remote.download(action.remote.id);
    await this.assertLocalUnchanged(path, action.local.hash);
    await this.writeLocal(action.remote, remoteData);
    return base && !isMergeable(path) ? `kept remote (newer); local copy at ${copy}` : `kept both; local copy at ${copy}`;
  }

  private async recordRemote(file: RemoteFile, data: Uint8Array) {
    this.manifest.set({ path: file.path, hash: await sha256(data), remoteId: file.id, revision: file.revision });
    if (isMergeable(file.path) || this.customMerge?.matches(file.path)) await this.base.set(file.path, data);
  }

  private async writeLocal(file: RemoteFile, data: Uint8Array) {
    await this.local.write(file.path, data);
    await this.recordRemote(file, data);
  }

  private async forget(path: VaultPath) {
    this.manifest.delete(path);
    await this.base.delete(path);
  }

  /** Refuse to overwrite or delete a local file edited after the scan. */
  private async assertLocalUnchanged(path: VaultPath, expected: string | undefined) {
    const current = (await this.local.exists(path)) ? await sha256(await this.local.read(path)) : undefined;
    if (current !== expected) throw new Error(`${path} changed during sync; will retry next sync`);
  }
}

interface ActionContext {
  local: Map<VaultPath, LocalState>;
  remote: Map<VaultPath, RemoteFile>;
  device: string;
  now: () => Date;
  /** Conflict copy paths handed out in this run. */
  reserved: Set<VaultPath>;
  commit: (manifest: Manifest) => Promise<void>;
}

function applyMovesToLocal(local: Map<VaultPath, LocalState>, moves: Move[]): Map<VaultPath, LocalState> {
  const out = new Map(local);
  for (const m of moves) {
    if (m.side !== "local") continue;
    const f = out.get(m.from)!;
    out.delete(m.from);
    out.set(m.to, { ...f, path: m.to });
  }
  return out;
}

function applyMovesToRemote(remote: Map<VaultPath, RemoteFile>, moves: Move[]): Map<VaultPath, RemoteFile> {
  const out = new Map(remote);
  for (const m of moves) {
    if (m.side !== "remote") continue;
    const f = out.get(m.from)!;
    out.delete(m.from);
    out.set(m.to, { ...f, path: m.to });
  }
  return out;
}

function applyMovesToManifest(manifest: Manifest, moves: Move[]): Manifest {
  const out = Manifest.fromJSON(manifest.toJSON());
  for (const m of moves) {
    const entry = out.get(m.from)!;
    out.delete(m.from);
    out.set({ ...entry, path: m.to });
  }
  return out;
}

function summarize(actions: Action[], moves: Move[], skipped: VaultPath[]): PlanSummary {
  const summary: PlanSummary = {
    uploads: [],
    downloads: [],
    unchanged: [],
    conflicts: [],
    deleteLocal: [],
    deleteRemote: [],
    moves,
    skipped,
  };
  for (const a of actions) {
    if (a.type === "upload") summary.uploads.push(a.path);
    else if (a.type === "download") summary.downloads.push(a.path);
    else if (a.type === "record") summary.unchanged.push(a.path);
    else if (a.type === "conflict") summary.conflicts.push(a.path);
    else if (a.type === "deleteLocal") summary.deleteLocal.push(a.path);
    else if (a.type === "deleteRemote") summary.deleteRemote.push(a.path);
  }
  return summary;
}
