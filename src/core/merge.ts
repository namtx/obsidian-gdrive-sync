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
