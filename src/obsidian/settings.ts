import { App, PluginSettingTab, Setting } from "obsidian";
import type { PendingAuth, Tokens } from "../drive/oauth";
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
      .setName("OAuth client ID")
      .setDesc("From your Google Cloud project (Web application client).")
      .addText((text) =>
        text
          .setPlaceholder("….apps.googleusercontent.com")
          .setValue(data.clientId)
          .onChange(async (value) => {
            data.clientId = value.trim();
            await this.plugin.save();
          }),
      );

    new Setting(containerEl)
      .setName("OAuth client secret")
      .setDesc("Stored only on this device.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(data.clientSecret).onChange(async (value) => {
          data.clientSecret = value.trim();
          await this.plugin.save();
        });
      });

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
              .setDisabled(!data.clientId || !data.clientSecret)
              .onClick(() => this.plugin.signIn()),
      );
  }
}
