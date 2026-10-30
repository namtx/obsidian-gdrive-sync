/** Hex-encoded SHA-256 of file content. */
export type Hash = string;

/** Vault-relative path using forward slashes, e.g. `folder/note.md`. */
export type VaultPath = string;

export interface LocalFile {
  path: VaultPath;
  size: number;
  /** Milliseconds since epoch. Used only to break binary conflicts, never for change detection. */
  mtime: number;
}

/** The device's vault, as seen by the sync engine. */
export interface LocalStore {
  list(): Promise<LocalFile[]>;
  exists(path: VaultPath): Promise<boolean>;
  read(path: VaultPath): Promise<Uint8Array>;
  /** Creates parent folders as needed. Overwrites an existing file. */
  write(path: VaultPath, data: Uint8Array): Promise<void>;
  delete(path: VaultPath): Promise<void>;
  rename(from: VaultPath, to: VaultPath): Promise<void>;
}

export interface RemoteFile {
  id: string;
  path: VaultPath;
  hash: Hash;
  /** Opaque revision identifier that changes on every content update. */
  revision: string;
  size: number;
  mtime: number;
}

export type RemoteChange =
  | { kind: "upsert"; file: RemoteFile }
  | { kind: "removed"; id: string };

export interface RemoteSnapshot {
  files: RemoteFile[];
  cursor: string;
}

export interface RemoteDelta {
  changes: RemoteChange[];
  cursor: string;
}

/** The sync folder in cloud storage, as seen by the sync engine. */
export interface RemoteStore {
  /** Full listing plus a cursor for later `changesSince` calls. */
  listAll(): Promise<RemoteSnapshot>;
  /** Changes since `cursor`, or `null` if the cursor is no longer valid. */
  changesSince(cursor: string): Promise<RemoteDelta | null>;
  download(id: string): Promise<Uint8Array>;
  /**
   * Creates a file at `path`, or replaces content of `id` when given. With
   * `expectedHash`, throws `RemoteChangedError` instead of overwriting content
   * that changed since this device last saw it.
   */
  upload(path: VaultPath, data: Uint8Array, id?: string, expectedHash?: Hash): Promise<RemoteFile>;
  move(id: string, to: VaultPath): Promise<RemoteFile>;
  /** Moves to trash, recoverable for a period; never a permanent delete. Same precondition as `upload`. */
  trash(id: string, expectedHash?: Hash): Promise<void>;
}

/**
 * The remote file changed since the state this device planned against, e.g.
 * because the change feed lagged. Nothing was written; the next sync sees it.
 */
export class RemoteChangedError extends Error {
  constructor(id: string) {
    super(`changed on Drive since the last sync (${id}); will retry next sync`);
  }
}
