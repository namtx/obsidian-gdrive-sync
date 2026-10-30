import { diff3Merge } from "node-diff3";
import type { VaultPath } from "./types";

/** Text files merged line by line. Everything else is treated as binary. */
export function isMergeable(path: VaultPath): boolean {
  return /\.(md|txt)$/i.test(path);
}

/** Split into lines, keeping each line's terminator so the merge round-trips exactly. */
function lines(s: string): string[] {
  return s.length === 0 ? [] : s.split(/(?<=\n)/);
}

/**
 * Line-based three-way merge. Returns the merged text, or `null` when both
 * sides changed the same region differently.
 */
export function mergeText(local: string, base: string, remote: string): string | null {
  const regions = diff3Merge(lines(local), lines(base), lines(remote), { excludeFalseConflicts: true });
  let out = "";
  for (const region of regions) {
    if (region.conflict) return null;
    out += (region.ok ?? []).join("");
  }
  return out;
}

/** `folder/note.md` → `folder/note (conflict <device> <YYYY-MM-DD>).md`, numbered if taken. */
export function conflictPath(path: VaultPath, device: string, date: Date, taken: (p: VaultPath) => boolean): VaultPath {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const hasExt = dot > slash + 1;
  const stem = hasExt ? path.slice(0, dot) : path;
  const ext = hasExt ? path.slice(dot) : "";
  const day = date.toISOString().slice(0, 10);
  const safeDevice = device.replace(/[\\/:*?"<>|]/g, "-");
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : ` ${n}`;
    const candidate = `${stem} (conflict ${safeDevice} ${day}${suffix})${ext}`;
    if (!taken(candidate)) return candidate;
  }
}

/**
 * Merge two JSON string arrays used as sets (e.g. the enabled-plugins list).
 * With a base, each side's additions and removals apply; without one (first
 * sync), the union is kept so neither device loses an enabled entry. Order:
 * local entries first, then remote additions. Null if either side is not a
 * string array.
 */
export function mergeStringSet(local: Uint8Array, base: Uint8Array | undefined, remote: Uint8Array): Uint8Array | null {
  const parse = (data: Uint8Array): string[] | null => {
    try {
      const value: unknown = JSON.parse(new TextDecoder().decode(data));
      return Array.isArray(value) && value.every((x) => typeof x === "string") ? value : null;
    } catch {
      return null;
    }
  };
  const l = parse(local);
  const r = parse(remote);
  const b = base ? parse(base) : [];
  if (!l || !r || !b) return null;
  const baseSet = new Set(b);
  const removed = new Set([...b.filter((x) => !l.includes(x)), ...b.filter((x) => !r.includes(x))]);
  const out: string[] = [];
  for (const x of [...l, ...r]) if (!out.includes(x) && !(baseSet.has(x) && removed.has(x))) out.push(x);
  return new TextEncoder().encode(JSON.stringify(out, null, 2));
}
