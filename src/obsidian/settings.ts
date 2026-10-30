import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type { RenameEvent } from "../core/renames";
import { parseClientJson, type PendingAuth, type Tokens } from "../drive/oauth";
import type GDriveSyncPlugin from "../main";

/** Everything in the plugin's data.json. Never synced: it holds this device's tokens. */
export interface PluginData {
  clientId: string;
  clientSecret: string;
  tokens: Tokens | null;
  pendingAuth: PendingAuth | null;
  /** Sync the config folder (settings, themes, other plugins). */
  syncConfig: boolean;
  /** Files above this size are skipped and listed. */
  maxFileSizeMB: number;
  /** Vault renames not yet consumed by a clean sync. */
  pendingRenames: RenameEvent[];
  /** Shown in conflict file names; empty means a default such as "Mac" or "iPhone". */
  deviceName: string;
  /** Foreground sync interval; 0 turns it off. */
  intervalMinutes: number;
}

export const DEFAULT_DATA: PluginData = {
  clientId: "",
  clientSecret: "",
  tokens: null,
  pendingAuth: null,
  syncConfig: false,
  maxFileSizeMB: 50,
  pendingRenames: [],
  deviceName: "",
  intervalMinutes: 5,
};

export class SettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: GDriveSyncPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const data = this.plugin.data;
    containerEl.empty();

    new Setting(containerEl).setName("Google account").setHeading();

    new Setting(containerEl)
      .setName("OAuth client")
      .setDesc(
        data.clientId
          ? `Using ${data.clientId}. Stored only on this device.`
          : "Import the client JSON downloaded from Google Cloud Console → Clients (Web application).",
      )
      .addButton((button) =>
        button
          .setButtonText(data.clientId ? "Replace client JSON" : "Import client JSON")
          .setCta()
          .onClick(() => this.pickClientJson()),
      );

    const signedIn = data.tokens !== null;
    new Setting(containerEl)
      .setName(signedIn ? "Signed in to Google Drive" : "Not signed in")
      .setDesc(signedIn ? "Sync uses your Drive folder ObsidianSync/<vault>." : "Opens your browser to grant access.")
      .addButton((button) =>
        signedIn
          ? button.setButtonText("Sign out").onClick(async () => {
              await this.plugin.signOut();
              this.display();
            })
          : button
              .setButtonText("Sign in")
              .setCta()
              .onClick(() => this.plugin.signIn()),
      );

    new Setting(containerEl).setName("Sync").setHeading();

    new Setting(containerEl)
      .setName("Sync now")
      .setDesc(`Drive folder: ObsidianSync/${this.app.vault.getName()}`)
      .addButton((button) =>
        button
          .setButtonText("Sync now")
          .setDisabled(!signedIn)
          .onClick(async () => {
            button.setDisabled(true);
            await this.plugin.syncNow();
            button.setDisabled(false);
          }),
      );

    new Setting(containerEl)
      .setName("Device name")
      .setDesc(`Used in conflict file names. Default: ${this.plugin.deviceName}.`)
      .addText((text) =>
        text.setPlaceholder(this.plugin.deviceName).setValue(data.deviceName).onChange(async (value) => {
          data.deviceName = value;
          await this.plugin.save();
        }),
      );

    new Setting(containerEl)
      .setName("Sync interval (minutes)")
      .setDesc("While Obsidian is open and in the foreground. 0 turns it off; syncs still run on open and after edits.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.setValue(String(data.intervalMinutes)).onChange(async (value) => {
          const n = Number(value);
          if (!Number.isFinite(n) || n < 0) return;
          data.intervalMinutes = n;
          await this.plugin.save();
        });
      });

    new Setting(containerEl)
      .setName("Maximum file size (MB)")
      .setDesc("Larger files are skipped and listed after each sync.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.setValue(String(data.maxFileSizeMB)).onChange(async (value) => {
          const n = Number(value);
          if (!Number.isFinite(n) || n <= 0) return;
          data.maxFileSizeMB = n;
          await this.plugin.save();
        });
      });

    new Setting(containerEl)
      .setName(`Sync ${this.app.vault.configDir} folder`)
      .setDesc(
        "Settings, themes and other plugins. Workspace layout and this plugin's own data (tokens) are never synced. Off by default.",
      )
      .addToggle((toggle) =>
        toggle.setValue(data.syncConfig).onChange(async (value) => {
          data.syncConfig = value;
          await this.plugin.save();
        }),
      );
  }

  private async pickClientJson() {
    try {
      const text = Platform.isDesktopApp ? await pickWithElectron() : await pickWithInput();
      if (text === null) return;
      await this.plugin.importClient(parseClientJson(text));
      new Notice("OAuth client imported. You can delete the downloaded JSON file now.");
    } catch (e) {
      new Notice(e instanceof Error ? e.message : String(e), 10_000);
    }
    this.display();
  }
}

/** Obsidian desktop silently drops file chooser requests from `<input type=file>`; use the native dialog. */
async function pickWithElectron(): Promise<string | null> {
  const { remote } = window.require("electron") as {
    remote: {
      dialog: {
        showOpenDialog(options: object): Promise<{ canceled: boolean; filePaths: string[] }>;
      };
    };
  };
  const result = await remote.dialog.showOpenDialog({
    title: "Import Google OAuth client JSON",
    properties: ["openFile"],
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  const path = result.filePaths[0];
  if (result.canceled || !path) return null;
  const fs = window.require("fs") as { promises: { readFile(path: string, encoding: "utf8"): Promise<string> } };
  return fs.promises.readFile(path, "utf8");
}

/** Opens the Files picker on iOS. The input must be in the document for `click()` to work. */
function pickWithInput(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const input = document.body.createEl("input", { type: "file", attr: { accept: ".json,application/json" } });
    input.style.display = "none";
    input.addEventListener("cancel", () => {
      input.remove();
      resolve(null);
    });
    input.onchange = () => {
      input.remove();
      const file = input.files?.[0];
      if (file) file.text().then(resolve, reject);
      else resolve(null);
    };
    input.click();
  });
}

declare global {
  interface Window {
    /** Node require, present only in Obsidian desktop. */
    require(id: string): unknown;
  }
}
