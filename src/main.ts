import { Notice, Plugin } from "obsidian";
import { finishAuth, PROTOCOL_ACTION, revoke, startAuth, TokenManager, type OAuthClient } from "./drive/oauth";
import { obsidianHttp } from "./obsidian/http";
import { DEFAULT_DATA, SettingsTab, type PluginData } from "./obsidian/settings";

export default class GDriveSyncPlugin extends Plugin {
  data: PluginData = { ...DEFAULT_DATA };
  tokenManager: TokenManager | null = null;
  private settingsTab!: SettingsTab;

  async onload() {
    this.data = { ...DEFAULT_DATA, ...((await this.loadData()) as Partial<PluginData> | null) };
    this.initTokenManager();

    this.settingsTab = new SettingsTab(this.app, this);
    this.addSettingTab(this.settingsTab);

    this.addCommand({ id: "sign-in", name: "Sign in to Google Drive", callback: () => this.signIn() });
    this.addCommand({ id: "sign-out", name: "Sign out of Google Drive", callback: () => this.signOut() });
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => new Notice("Google Drive Sync: not implemented yet"),
    });

    this.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) => this.completeSignIn(params));
  }

  async save() {
    await this.saveData(this.data);
  }

  private get client(): OAuthClient {
    return { clientId: this.data.clientId, clientSecret: this.data.clientSecret };
  }

  private initTokenManager() {
    const tokens = this.data.tokens;
    this.tokenManager = tokens
      ? new TokenManager(obsidianHttp, this.client, tokens, async (t) => {
          this.data.tokens = t;
          await this.save();
        })
      : null;
  }

  async signIn() {
    if (!this.data.clientId || !this.data.clientSecret) {
      new Notice("Enter your OAuth client ID and secret in the plugin settings first.");
      return;
    }
    const { url, pending } = await startAuth(this.client);
    this.data.pendingAuth = pending;
    await this.save();
    window.open(url);
  }

  private async completeSignIn(params: Record<string, string>) {
    try {
      const tokens = await finishAuth(obsidianHttp, this.client, this.data.pendingAuth, params);
      this.data.tokens = tokens;
      new Notice("Signed in to Google Drive.");
    } catch (e) {
      new Notice(e instanceof Error ? e.message : String(e));
    } finally {
      this.data.pendingAuth = null;
      await this.save();
      this.initTokenManager();
      this.settingsTab.display();
    }
  }

  async signOut() {
    const tokens = this.data.tokens;
    this.data.tokens = null;
    this.tokenManager = null;
    await this.save();
    if (tokens) await revoke(obsidianHttp, tokens.refreshToken).catch(() => {});
    new Notice("Signed out of Google Drive.");
  }
}
