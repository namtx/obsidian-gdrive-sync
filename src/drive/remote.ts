import { sha256 } from "../core/hash";
import {
  RemoteChangedError,
  type Hash,
  type RemoteChange,
  type RemoteDelta,
  type RemoteFile,
  type RemoteSnapshot,
  type RemoteStore,
  type VaultPath,
} from "../core/types";
import { header, type DriveClient } from "./client";
import { HttpError } from "./http";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";
const FILE_FIELDS = "id,name,parents,mimeType,trashed,sha256Checksum,size,modifiedTime,headRevisionId,version";

interface DriveFile {
  id: string;
  name: string;
  parents?: string[];
  mimeType: string;
  trashed?: boolean;
  sha256Checksum?: string;
  size?: string;
  modifiedTime?: string;
  headRevisionId?: string;
  version?: string;
}

interface Folder {
  name: string;
  parentId: string | undefined;
}

export interface DriveRemoteOptions {
  /** Folder names from My Drive down to the vault folder, e.g. `["ObsidianSync", "My Vault"]`. */
  rootPath: string[];
  /** Files at or above this size use resumable upload. */
  resumableThreshold?: number;
  /** Resumable chunk size; Drive requires a multiple of 256 KiB. */
  chunkSize?: number;
}

/**
 * `RemoteStore` over the Drive REST API with the `drive.file` scope. The vault
 * is mirrored as a visible folder tree; paths are derived from parent links.
 */
export class DriveRemoteStore implements RemoteStore {
  private rootId: string | null = null;
  /** Every folder the app can see, by id. Loaded with each full listing. */
  private folders: Map<string, Folder> | null = null;
  private idPool: string[] = [];
  private resumableThreshold: number;
  private chunkSize: number;

  constructor(
    private client: DriveClient,
    private options: DriveRemoteOptions,
  ) {
    this.resumableThreshold = options.resumableThreshold ?? 5 * 1024 * 1024;
    this.chunkSize = options.chunkSize ?? 8 * 1024 * 1024;
  }

  async listAll(): Promise<RemoteSnapshot> {
    await this.root();
    // Take the cursor first so nothing that changes during the listing is missed.
    const cursor = await this.startPageToken();
    const all = await this.listFiles("trashed = false");
    this.folders = new Map();
    for (const f of all) if (f.mimeType === FOLDER) this.folders.set(f.id, { name: f.name, parentId: f.parents?.[0] });

    const byPath = new Map<VaultPath, RemoteFile>();
    for (const f of all) {
      if (f.mimeType === FOLDER) continue;
      const file = this.toRemote(f);
      if (!file) continue;
      // Drive allows duplicate names; keep the most recently modified.
      const existing = byPath.get(file.path);
      if (!existing || existing.mtime < file.mtime) byPath.set(file.path, file);
    }
    return { files: [...byPath.values()], cursor };
  }

  async changesSince(cursor: string): Promise<RemoteDelta | null> {
    await this.root();
    if (!this.folders) await this.loadFolders();
    const changes: Array<{ fileId: string; removed?: boolean; file?: DriveFile }> = [];
    let pageToken = cursor;
    let next: string;
    for (;;) {
      const params = new URLSearchParams({
        pageToken,
        pageSize: "1000",
        spaces: "drive",
        includeRemoved: "true",
        fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`,
      });
      const res = await this.client.request({ url: `${API}/changes?${params}` });
      // An expired or malformed page token: the caller falls back to a full listing.
      if (res.status === 400 || res.status === 404) return null;
      if (res.status !== 200) throw new HttpError(res.status, res.text, "Drive changes");
      const page = JSON.parse(res.text) as {
        nextPageToken?: string;
        newStartPageToken?: string;
        changes: typeof changes;
      };
      changes.push(...page.changes);
      if (page.nextPageToken) pageToken = page.nextPageToken;
      else {
        next = page.newStartPageToken!;
        break;
      }
    }

    // Folders first, so files in a folder created in the same batch resolve.
    for (const c of changes) {
      const f = c.file;
      const known = this.folders!.get(c.fileId);
      if (f && f.mimeType === FOLDER && !f.trashed && !c.removed) {
        // A renamed or moved folder changes every path below it; only a full listing can rebuild them.
        if (known && (known.name !== f.name || known.parentId !== f.parents?.[0])) return null;
        this.folders!.set(f.id, { name: f.name, parentId: f.parents?.[0] });
      } else if (known) {
        return null;
      }
    }

    const out: RemoteChange[] = [];
    for (const c of changes) {
      if (c.file?.mimeType === FOLDER || this.folders!.has(c.fileId)) continue;
      const file = !c.removed && c.file && !c.file.trashed ? this.toRemote(c.file) : null;
      // Trashed, deleted, or moved out of the vault folder.
      out.push(file ? { kind: "upsert", file } : { kind: "removed", id: c.fileId });
    }
    return { changes: out, cursor: next };
  }

  async download(id: string): Promise<Uint8Array> {
    const res = await this.client.request({ url: `${API}/files/${id}?alt=media` });
    if (res.status !== 200) throw new HttpError(res.status, res.text, `Drive download ${id}`);
    return new Uint8Array(res.arrayBuffer);
  }

  async upload(path: VaultPath, data: Uint8Array, id?: string, expectedHash?: Hash): Promise<RemoteFile> {
    const hash = await sha256(data);
    let file: DriveFile;
    if (id) {
      await this.assertUnchanged(id, expectedHash);
      file = await this.sendContent(data, { id });
    } else {
      const { parentId, name } = await this.parentFor(path);
      const newId = await this.newId();
      try {
        file = await this.sendContent(data, { create: { id: newId, name, parents: [parentId] } });
      } catch (e) {
        // A retried create whose first attempt succeeded: the id is taken by our own file.
        if (!(e instanceof HttpError && e.status === 409)) throw e;
        file = await this.sendContent(data, { id: newId });
      }
    }
    // The checksum can lag right after an upload; we know the content we sent.
    return this.toRemote({ ...file, sha256Checksum: file.sha256Checksum ?? hash }, path)!;
  }

  async move(id: string, to: VaultPath): Promise<RemoteFile> {
    const current = await this.client.json<DriveFile>({ url: `${API}/files/${id}?fields=parents` }, "Drive get parents");
    const { parentId, name } = await this.parentFor(to);
    const params = new URLSearchParams({ fields: FILE_FIELDS, addParents: parentId });
    const old = (current.parents ?? []).filter((p) => p !== parentId);
    if (old.length) params.set("removeParents", old.join(","));
    const file = await this.client.json<DriveFile>(
      {
        url: `${API}/files/${id}?${params}`,
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      },
      `Drive move to ${to}`,
    );
    return this.toRemote(file, to)!;
  }

  async trash(id: string, expectedHash?: Hash): Promise<void> {
    await this.assertUnchanged(id, expectedHash);
    await this.client.json(
      {
        url: `${API}/files/${id}?fields=id`,
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trashed: true }),
      },
      `Drive trash ${id}`,
    );
  }

  /**
   * Trash the whole vault folder. Used to clean up test runs. Children go
   * first, deepest last-in: with `drive.file`, trashing a non-empty folder in
   * one call fails with 403 ("may not have granted write access to all of the children").
   */
  async trashRoot(): Promise<void> {
    const rootId = await this.root();
    const all = await this.listFiles("trashed = false");
    this.folders = new Map();
    for (const f of all) if (f.mimeType === FOLDER) this.folders.set(f.id, { name: f.name, parentId: f.parents?.[0] });
    const inside = all
      .map((f) => ({ f, path: this.pathOf(f) }))
      .filter((x): x is { f: DriveFile; path: string } => x.path !== null);
    const depth = (p: string) => p.split("/").length;
    for (const { f } of inside.filter((x) => x.f.mimeType !== FOLDER)) await this.trash(f.id);
    for (const { f } of inside.filter((x) => x.f.mimeType === FOLDER).sort((a, b) => depth(b.path) - depth(a.path)))
      await this.trash(f.id);
    await this.trash(rootId);
    this.rootId = null;
    this.folders = null;
  }

  /**
   * Drive v3 has no conditional update, so check the content hash just before
   * writing. This closes the gap where the change feed lags behind another
   * device's upload; a write racing within this check itself remains possible.
   */
  private async assertUnchanged(id: string, expectedHash: Hash | undefined) {
    if (expectedHash === undefined) return;
    const current = await this.client.json<DriveFile>(
      { url: `${API}/files/${id}?fields=sha256Checksum,trashed` },
      `Drive check ${id}`,
    );
    if (current.trashed || current.sha256Checksum !== expectedHash) throw new RemoteChangedError(id);
  }

  // --- folders and paths -----------------------------------------------------

  /** Find or create the vault folder, e.g. `My Drive/ObsidianSync/<vault>`. */
  private async root(): Promise<string> {
    if (this.rootId) return this.rootId;
    let parent = "root";
    for (const name of this.options.rootPath) {
      const q = `name = '${escape(name)}' and mimeType = '${FOLDER}' and '${parent}' in parents and trashed = false`;
      const found = await this.listFiles(q, "createdTime");
      parent = found[0]?.id ?? (await this.createFolder(name, parent));
    }
    this.rootId = parent;
    return parent;
  }

  private async loadFolders() {
    this.folders = new Map();
    for (const f of await this.listFiles(`mimeType = '${FOLDER}' and trashed = false`))
      this.folders.set(f.id, { name: f.name, parentId: f.parents?.[0] });
  }

  /** Vault path of a file, or null if it is not inside the vault folder. */
  private pathOf(f: DriveFile): VaultPath | null {
    const parts = [f.name];
    let parent = f.parents?.[0];
    for (let depth = 0; parent && depth < 100; depth++) {
      if (parent === this.rootId) return parts.reverse().join("/");
      const folder = this.folders?.get(parent);
      if (!folder) return null;
      parts.push(folder.name);
      parent = folder.parentId;
    }
    return null;
  }

  private async parentFor(path: VaultPath): Promise<{ parentId: string; name: string }> {
    const parts = path.split("/");
    const name = parts.pop()!;
    let parentId = await this.root();
    if (!this.folders) await this.loadFolders();
    for (const part of parts) {
      let child: string | undefined;
      for (const [id, f] of this.folders!) if (f.parentId === parentId && f.name === part) child = id;
      parentId = child ?? (await this.createFolder(part, parentId));
    }
    return { parentId, name };
  }

  private async createFolder(name: string, parentId: string): Promise<string> {
    const f = await this.client.json<DriveFile>(
      {
        url: `${API}/files?fields=id,name,parents`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, mimeType: FOLDER, parents: [parentId] }),
      },
      `Drive create folder ${name}`,
    );
    this.folders?.set(f.id, { name, parentId });
    return f.id;
  }

  // --- requests ----------------------------------------------------------------

  private async listFiles(q: string, orderBy?: string): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q,
        spaces: "drive",
        pageSize: "1000",
        fields: `nextPageToken,files(${FILE_FIELDS})`,
      });
      if (orderBy) params.set("orderBy", orderBy);
      if (pageToken) params.set("pageToken", pageToken);
      const page = await this.client.json<{ files: DriveFile[]; nextPageToken?: string }>(
        { url: `${API}/files?${params}` },
        "Drive list",
      );
      out.push(...page.files);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  private async startPageToken(): Promise<string> {
    const res = await this.client.json<{ startPageToken: string }>(
      { url: `${API}/changes/startPageToken` },
      "Drive start page token",
    );
    return res.startPageToken;
  }

  /** Pre-generated ids make creates idempotent: a retried create gets 409 instead of a duplicate file. */
  private async newId(): Promise<string> {
    if (this.idPool.length === 0) {
      const res = await this.client.json<{ ids: string[] }>(
        { url: `${API}/files/generateIds?count=100&space=drive&type=files` },
        "Drive generate ids",
      );
      this.idPool = res.ids;
    }
    return this.idPool.pop()!;
  }

  private async sendContent(
    data: Uint8Array,
    target: { id: string } | { create: { id: string; name: string; parents: string[] } },
  ): Promise<DriveFile> {
    if (data.length >= this.resumableThreshold) return this.sendResumable(data, target);
    if ("id" in target) {
      return this.client.json<DriveFile>(
        {
          url: `${UPLOAD}/files/${target.id}?uploadType=media&fields=${FILE_FIELDS}`,
          method: "PATCH",
          headers: { "Content-Type": "application/octet-stream" },
          body: toArrayBuffer(data),
        },
        `Drive update ${target.id}`,
      );
    }
    const boundary = `obsidian-gdrive-sync-${Math.random().toString(36).slice(2)}`;
    return this.client.json<DriveFile>(
      {
        url: `${UPLOAD}/files?uploadType=multipart&fields=${FILE_FIELDS}`,
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body: multipartBody(boundary, target.create, data),
      },
      `Drive create ${target.create.name}`,
    );
  }

  private async sendResumable(
    data: Uint8Array,
    target: { id: string } | { create: { id: string; name: string; parents: string[] } },
  ): Promise<DriveFile> {
    const start = await this.client.request(
      "id" in target
        ? {
            url: `${UPLOAD}/files/${target.id}?uploadType=resumable&fields=${FILE_FIELDS}`,
            method: "PATCH",
            headers: { "X-Upload-Content-Length": String(data.length) },
          }
        : {
            url: `${UPLOAD}/files?uploadType=resumable&fields=${FILE_FIELDS}`,
            method: "POST",
            headers: {
              "Content-Type": "application/json; charset=UTF-8",
              "X-Upload-Content-Length": String(data.length),
            },
            body: JSON.stringify(target.create),
          },
    );
    if (start.status !== 200) throw new HttpError(start.status, start.text, "Drive start resumable upload");
    const session = header(start, "Location");
    if (!session) throw new Error("Drive resumable upload returned no session URL");

    let offset = 0;
    for (;;) {
      const end = Math.min(offset + this.chunkSize, data.length);
      const res = await this.client.request({
        url: session,
        method: "PUT",
        headers: { "Content-Range": `bytes ${offset}-${end - 1}/${data.length}` },
        body: toArrayBuffer(data.subarray(offset, end)),
      });
      if (res.status === 200 || res.status === 201) return JSON.parse(res.text) as DriveFile;
      if (res.status !== 308) throw new HttpError(res.status, res.text, "Drive resumable upload");
      // Drive reports what it has; resume from there rather than from what we sent.
      const range = header(res, "Range");
      offset = range ? Number(range.split("-")[1]) + 1 : 0;
    }
  }

  private toRemote(f: DriveFile, knownPath?: VaultPath): RemoteFile | null {
    const path = knownPath ?? this.pathOf(f);
    if (!path) return null;
    return {
      id: f.id,
      path,
      hash: f.sha256Checksum ?? "",
      revision: f.headRevisionId ?? f.version ?? "",
      size: Number(f.size ?? 0),
      mtime: f.modifiedTime ? Date.parse(f.modifiedTime) : 0,
    };
  }
}

function escape(name: string): string {
  return name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

export function multipartBody(boundary: string, metadata: object, data: Uint8Array): ArrayBuffer {
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--`);
  const out = new Uint8Array(head.length + data.length + tail.length);
  out.set(head, 0);
  out.set(data, head.length);
  out.set(tail, head.length + data.length);
  return out.buffer;
}
