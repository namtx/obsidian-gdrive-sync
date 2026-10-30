import type { Manifest } from "./manifest";
import type { LocalState } from "./plan";
import type { Hash, RemoteFile, VaultPath } from "./types";

/** A rename observed in the vault since the last sync, in the order it happened. */
export interface RenameEvent {
  from: VaultPath;
  to: VaultPath;
}

export type Move =
  /** Renamed on this device: move the Drive file by id. */
  | { side: "remote"; from: VaultPath; to: VaultPath; remoteId: string; via: "event" | "hash" }
  /** Renamed on another device: rename the local file. */
  | { side: "local"; from: VaultPath; to: VaultPath; remoteId: string };

/** Collapse chains like a→b, b→c into a→c and drop round trips. */
export function collapseRenames(events: RenameEvent[]): RenameEvent[] {
  const originOf = new Map<VaultPath, VaultPath>();
  for (const { from, to } of events) {
    const origin = originOf.get(from) ?? from;
    originOf.delete(from);
    originOf.set(to, origin);
  }
  return [...originOf].filter(([to, from]) => to !== from).map(([to, from]) => ({ from, to }));
}

/**
 * Find renames on either side. A local rename is only applied when the remote
 * file is still where the manifest left it, so moves never fight a concurrent
 * remote change; anything not matched here falls through to delete + create.
 */
export function detectRenames(
  local: Map<VaultPath, LocalState>,
  remote: Map<VaultPath, RemoteFile>,
  manifest: Manifest,
  events: RenameEvent[] = [],
): Move[] {
  const moves: Move[] = [];
  const used = new Set<VaultPath>();
  const claim = (...paths: VaultPath[]) => paths.forEach((p) => used.add(p));
  const free = (...paths: VaultPath[]) => paths.every((p) => !used.has(p));

  const localMoveOk = (from: VaultPath, to: VaultPath): string | null => {
    const entry = manifest.get(from);
    if (!entry || local.has(from) || !local.has(to) || manifest.get(to) || remote.has(to)) return null;
    if (remote.get(from)?.id !== entry.remoteId) return null;
    return entry.remoteId;
  };

  for (const { from, to } of collapseRenames(events)) {
    const remoteId = localMoveOk(from, to);
    if (remoteId && free(from, to)) {
      moves.push({ side: "remote", from, to, remoteId, via: "event" });
      claim(from, to);
    }
  }

  // Renamed on another device: the Drive id now lives at a different path.
  const remoteById = new Map([...remote.values()].map((f) => [f.id, f]));
  for (const entry of manifest.entries()) {
    const moved = remoteById.get(entry.remoteId);
    if (!moved || moved.path === entry.path) continue;
    const from = entry.path;
    const to = moved.path;
    if (!local.has(from) || local.has(to) || manifest.get(to) || !free(from, to)) continue;
    moves.push({ side: "local", from, to, remoteId: entry.remoteId });
    claim(from, to);
  }

  // Fallback: a synced file vanished locally and exactly one new file has its content.
  const vanished = new Map<Hash, VaultPath[]>();
  for (const entry of manifest.entries()) {
    const r = remote.get(entry.path);
    if (local.has(entry.path) || !r || r.id !== entry.remoteId || r.hash !== entry.hash || used.has(entry.path)) continue;
    push(vanished, entry.hash, entry.path);
  }
  const arrived = new Map<Hash, VaultPath[]>();
  for (const l of local.values()) {
    if (manifest.get(l.path) || remote.has(l.path) || used.has(l.path)) continue;
    push(arrived, l.hash, l.path);
  }
  for (const [hash, froms] of vanished) {
    const tos = arrived.get(hash);
    if (froms.length !== 1 || tos?.length !== 1) continue;
    const from = froms[0]!;
    const to = tos[0]!;
    moves.push({ side: "remote", from, to, remoteId: manifest.get(from)!.remoteId, via: "hash" });
    claim(from, to);
  }

  return moves;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
