import type { Manifest, ManifestEntry } from "./manifest";
import type { Hash, RemoteFile, VaultPath } from "./types";

export interface LocalState {
  path: VaultPath;
  hash: Hash;
  mtime: number;
}

export type Action =
  /** Local is new or changed; remote unchanged or absent. */
  | { type: "upload"; path: VaultPath; remoteId?: string; expectedHash?: Hash }
  /** Remote is new or changed; local unchanged or absent. */
  | { type: "download"; path: VaultPath; remote: RemoteFile }
  /** Both sides hold the same content; only the manifest needs updating. */
  | { type: "record"; path: VaultPath; remote: RemoteFile }
  /** Deleted locally, unchanged remotely. */
  | { type: "deleteRemote"; path: VaultPath; remoteId: string; expectedHash: Hash }
  /** Deleted remotely, unchanged locally. */
  | { type: "deleteLocal"; path: VaultPath }
  /** Both deleted; only the manifest entry goes. */
  | { type: "forget"; path: VaultPath }
  /** Both sides changed to different content since the last sync. */
  | { type: "conflict"; path: VaultPath; local: LocalState; remote: RemoteFile; base?: ManifestEntry };

/**
 * Compare each path's local and remote content hash against the last synced
 * hash in the manifest. Modified times are never used to detect change.
 */
export function plan(
  local: Map<VaultPath, LocalState>,
  remote: Map<VaultPath, RemoteFile>,
  manifest: Manifest,
): Action[] {
  const paths = new Set<VaultPath>([...local.keys(), ...remote.keys(), ...manifest.entries().map((e) => e.path)]);
  const actions: Action[] = [];
  for (const path of [...paths].sort()) {
    const action = decide(path, local.get(path), remote.get(path), manifest.get(path));
    if (action) actions.push(action);
  }
  return actions;
}

function decide(
  path: VaultPath,
  l: LocalState | undefined,
  r: RemoteFile | undefined,
  base: ManifestEntry | undefined,
): Action | null {
  const localChanged = l?.hash !== base?.hash;
  const remoteChanged = r?.hash !== base?.hash;

  if (!localChanged && !remoteChanged) return null;

  if (localChanged && !remoteChanged) {
    if (l) return { type: "upload", path, remoteId: r?.id, expectedHash: r?.hash };
    return { type: "deleteRemote", path, remoteId: r!.id, expectedHash: r!.hash };
  }

  if (!localChanged && remoteChanged) {
    if (r) return { type: "download", path, remote: r };
    return { type: "deleteLocal", path };
  }

  // Both changed since the base (or there is no base).
  if (!l && !r) return { type: "forget", path };
  if (l && r && l.hash === r.hash) return { type: "record", path, remote: r };
  if (l && r) return { type: "conflict", path, local: l, remote: r, base };
  // One side deleted, the other edited: keep the edit, never drop it.
  if (l) return { type: "upload", path };
  return { type: "download", path, remote: r! };
}
