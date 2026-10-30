import type { PlanSummary, SyncResult } from "../core/engine";

export type SyncState =
  | { kind: "signedOut" }
  | { kind: "syncing" }
  | { kind: "never" }
  | { kind: "paused"; reason: "firstSync" | "massDelete" }
  | { kind: "error"; message: string; at: number }
  | { kind: "partial"; failed: number; at: number }
  | { kind: "synced"; at: number; skipped: number };

export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** Short status bar text. */
export function statusText(state: SyncState, now: number): string {
  switch (state.kind) {
    case "signedOut":
      return "Drive: signed out";
    case "syncing":
      return "Drive: syncing…";
    case "never":
      return "Drive: not synced yet";
    case "paused":
      return state.reason === "firstSync" ? "Drive: confirm first sync" : "Drive: confirm deletes";
    case "error":
      return `Drive: sync failed ${ago(state.at, now)}`;
    case "partial":
      return `Drive: ${state.failed} not synced`;
    case "synced":
      return `Drive: synced ${ago(state.at, now)}${state.skipped ? ` (${state.skipped} skipped)` : ""}`;
  }
}

export interface SummarySection {
  label: string;
  paths: string[];
}

/** The plan sections a confirmation dialog or log shows, non-empty ones only. */
export function summarySections(s: PlanSummary): SummarySection[] {
  return [
    { label: "Upload to Drive", paths: s.uploads },
    { label: "Download from Drive", paths: s.downloads },
    { label: "Already identical (no transfer)", paths: s.unchanged },
    { label: "Conflicts (both versions kept)", paths: s.conflicts },
    { label: "Delete on this device (to trash)", paths: s.deleteLocal },
    { label: "Delete on Drive (to Drive trash)", paths: s.deleteRemote },
    { label: "Move", paths: s.moves.map((m) => `${m.from} → ${m.to}`) },
    { label: "Skipped (over size limit)", paths: s.skipped },
  ].filter((x) => x.paths.length > 0);
}

export function confirmationTitle(result: Extract<SyncResult, { status: "needsConfirmation" }>): string {
  if (result.reason === "firstSync") return "Confirm first sync";
  const n = result.summary.deleteLocal.length + result.summary.deleteRemote.length;
  return `Confirm deleting ${n} files`;
}

export function confirmationText(result: Extract<SyncResult, { status: "needsConfirmation" }>): string {
  if (result.reason === "firstSync")
    return "This is the first sync between this vault and its Drive folder. Nothing has changed yet. Review what will happen:";
  return "This sync would delete more files than the safety limit allows (over 20% of the vault or over 50 files). Deleted files go to the trash and can be restored. Nothing has changed yet.";
}
