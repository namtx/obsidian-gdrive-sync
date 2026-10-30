import { App, Modal, Setting } from "obsidian";
import type { SyncResult } from "../core/engine";
import type { SyncRecord } from "./sync-runner";
import { confirmationText, confirmationTitle, summarySections, type SummarySection } from "./status";

/** Long lists collapse: a vault's first sync can list thousands of files. */
const MAX_LISTED = 200;

function renderSections(el: HTMLElement, sections: SummarySection[], open: boolean) {
  for (const section of sections) {
    const details = el.createEl("details", { cls: "gdrive-sync-section" });
    details.open = open && section.paths.length <= 20;
    details.createEl("summary", { text: `${section.label}: ${section.paths.length}` });
    const list = details.createEl("ul");
    for (const path of section.paths.slice(0, MAX_LISTED)) list.createEl("li", { text: path });
    if (section.paths.length > MAX_LISTED) list.createEl("li", { text: `… and ${section.paths.length - MAX_LISTED} more` });
  }
}

/** Shows a paused plan; nothing runs unless the user presses the confirm button. */
export class ConfirmSyncModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private result: Extract<SyncResult, { status: "needsConfirmation" }>,
    private onDecision: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl, result } = this;
    this.setTitle(confirmationTitle(result));
    contentEl.createEl("p", { text: confirmationText(result) });
    const sections = summarySections(result.summary);
    if (sections.length === 0) contentEl.createEl("p", { text: "Both sides are empty; nothing to transfer." });
    renderSections(contentEl, sections, true);
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.decide(false)))
      .addButton((b) =>
        b
          .setButtonText(result.reason === "firstSync" ? "Start sync" : "Delete and sync")
          .setCta()
          .onClick(() => this.decide(true)),
      );
  }

  private decide(confirmed: boolean) {
    this.decided = true;
    this.close();
    this.onDecision(confirmed);
  }

  onClose() {
    this.contentEl.empty();
    // Closing with Esc or the X counts as cancel.
    if (!this.decided) this.onDecision(false);
  }
}

/** What the last sync did, including per-file errors. */
export class SyncLogModal extends Modal {
  constructor(
    app: App,
    private record: SyncRecord | null,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl, record } = this;
    this.setTitle("Last Google Drive sync");
    if (!record) {
      contentEl.createEl("p", { text: "No sync has run since Obsidian started." });
      return;
    }
    const seconds = ((record.finishedAt - record.startedAt) / 1000).toFixed(1);
    const status = record.error ? "failed" : (record.result?.status ?? "skipped");
    contentEl.createEl("p", {
      text: `${new Date(record.startedAt).toLocaleString()} · trigger: ${record.trigger} · ${status} · ${seconds} s`,
    });
    if (record.error) contentEl.createEl("p", { cls: "gdrive-sync-error", text: record.error });
    if (!record.result) return;

    const failures = record.result.log.filter((e) => !e.ok);
    if (failures.length) {
      contentEl.createEl("h4", { text: `Not synced (${failures.length}), will retry` });
      const list = contentEl.createEl("ul");
      for (const e of failures) list.createEl("li", { cls: "gdrive-sync-error", text: `${e.path}: ${e.detail ?? e.action}` });
    }
    renderSections(contentEl, summarySections(record.result.summary), false);

    const done = record.result.log.filter((e) => e.ok);
    if (done.length) {
      const details = contentEl.createEl("details", { cls: "gdrive-sync-section" });
      details.createEl("summary", { text: `Actions (${done.length})` });
      const list = details.createEl("ul");
      for (const e of done.slice(0, MAX_LISTED))
        list.createEl("li", { text: `${e.action} ${e.path}${e.detail ? ` (${e.detail})` : ""}` });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
