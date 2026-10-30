import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import { parseClientJson, type PendingAuth, type Tokens } from "../drive/oauth";
import type GDriveSyncPlugin from "../main";

/** Everything in the plugin's data.json. Never synced: it holds this device's tokens. */
export interface PluginData {
  clientId: string;
  clientSecret: string;
  tokens: Tokens | null;
  pendingAuth: PendingAuth | null;
}

export const DEFAULT_DATA: PluginData = {
  clientId: "",
  clientSecret: "",
  tokens: null,
  pendingAuth: null,
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
