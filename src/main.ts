import { Notice, Platform, Plugin, TFile, type TAbstractFile } from "obsidian";
import type { SyncResult } from "./core/engine";
import { statusText, type SyncState } from "./obsidian/status";
import { ConfirmSyncModal, SyncLogModal } from "./obsidian/ui";
import { AdapterBaseStore } from "./obsidian/base-store";
import { ObsidianLocalStore } from "./obsidian/local-store";
import { RenameJournal } from "./obsidian/rename-journal";
import { inScope, type ScopeSettings } from "./obsidian/scope";
import { SyncController } from "./obsidian/sync-controller";
import { SyncRunner } from "./obsidian/sync-runner";
import { finishAuth, PROTOCOL_ACTION, revoke, startAuth, TokenManager, type OAuthClient } from "./drive/oauth";
import { obsidianHttp } from "./obsidian/http";
import { DEFAULT_DATA, SettingsTab, type PluginData } from "./obsidian/settings";

export default class GDriveSyncPlugin extends Plugin {
  data: PluginData = { ...DEFAULT_DATA };
  tokenManager: TokenManager | null = null;
  localStore!: ObsidianLocalStore;
  baseStore!: AdapterBaseStore;
  renames!: RenameJournal;
  runner!: SyncRunner;
  controller!: SyncController;
  onSyncStarted = () => this.updateStatus();
  onSyncFinished = () => this.updateStatus();
  private settingsTab!: SettingsTab;
  private statusEl: HTMLElement | null = null;
  private confirmOpen = false;

  async onload() {
    this.data = { ...DEFAULT_DATA, ...((await this.loadData()) as Partial<PluginData> | null) };
    this.initTokenManager();

    this.localStore = new ObsidianLocalStore(this.app.vault, () => this.scope);
    this.baseStore = new AdapterBaseStore(this.app.vault.adapter, `${this.pluginDir}/bases`);
    this.renames = new RenameJournal(this.data.pendingRenames, async (events) => {
      this.data.pendingRenames = events;
      await this.save();
    });
    // Folder renames also fire for each file inside, so files are enough.
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) void this.renames.record(oldPath, file.path);
      }),
    );

    this.runner = new SyncRunner(this);
    await this.runner.load();
    this.controller = new SyncController(async (trigger) => void (await this.runner.run(trigger)));
    this.register(() => this.controller.dispose());

    this.settingsTab = new SettingsTab(this.app, this);
    this.addSettingTab(this.settingsTab);

    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.syncNow() });
    this.addRibbonIcon("refresh-cw", "Sync with Google Drive", () => this.syncNow());
    this.addCommand({ id: "show-log", name: "Show last sync log", callback: () => this.showLog() });
    this.addCommand({ id: "sign-in", name: "Sign in to Google Drive", callback: () => this.signIn() });

    // Desktop only: Obsidian mobile has no status bar. Mobile gets notices and the log command.
    if (!Platform.isMobile) {
      this.statusEl = this.addStatusBarItem();
      this.statusEl.addClass("gdrive-sync-status");
      this.statusEl.onClickEvent(() => this.showLog());
      this.registerInterval(window.setInterval(() => this.updateStatus(), 30_000));
      this.updateStatus();
    }
    this.addCommand({ id: "sign-out", name: "Sign out of Google Drive", callback: () => this.signOut() });

    this.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) => this.completeSignIn(params));

    // Vault "create" events fire for every file while the vault loads; listen only once it is ready.
    this.app.workspace.onLayoutReady(() => {
      const onEdit = (file: TAbstractFile) => this.noteEdit(file.path);
      this.registerEvent(this.app.vault.on("create", onEdit));
      this.registerEvent(this.app.vault.on("modify", onEdit));
      this.registerEvent(this.app.vault.on("delete", onEdit));
      this.registerEvent(this.app.vault.on("rename", onEdit));
      void this.controller.trigger("startup");
    });

    // Coming back to the foreground counts as opening the app (iOS suspends it in the background).
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible" && Date.now() - this.controller.lastFinished > 60_000)
        void this.controller.trigger("resume");
    });

    // Checked every 30 s, so interval changes in settings apply without re-registering.
    this.registerInterval(
      window.setInterval(() => {
        const minutes = this.data.intervalMinutes;
        if (minutes <= 0 || document.visibilityState !== "visible") return;
        if (Date.now() - this.controller.lastFinished >= minutes * 60_000) void this.controller.trigger("interval");
      }, 30_000),
    );
  }

  syncNow(): Promise<void> {
    return this.controller.trigger("manual");
  }

  showLog() {
    new SyncLogModal(this.app, this.runner.last).open();
  }

  /** Open the confirmation dialog for a paused plan; confirming runs the sync with that approval. */
  askConfirmation(result: Extract<SyncResult, { status: "needsConfirmation" }>) {
    if (this.confirmOpen) return;
    this.confirmOpen = true;
    new ConfirmSyncModal(this.app, result, (confirmed) => {
      this.confirmOpen = false;
      if (!confirmed) {
        new Notice("Google Drive Sync paused. Run Sync now to review again.");
        this.updateStatus();
        return;
      }
      this.runner.nextOptions = result.reason === "firstSync" ? { confirmFirstSync: true } : { confirmDeletes: true };
      this.runner.paused = null;
      void this.syncNow();
    }).open();
  }

  get syncState(): SyncState {
    if (!this.tokenManager) return { kind: "signedOut" };
    if (this.runner.active) return { kind: "syncing" };
    if (this.runner.paused) return { kind: "paused", reason: this.runner.paused };
    const last = this.runner.last;
    if (!last) return { kind: "never" };
    if (last.error) return { kind: "error", message: last.error, at: last.finishedAt };
    if (last.result?.status === "partial")
      return { kind: "partial", failed: last.result.log.filter((e) => !e.ok).length, at: last.finishedAt };
    if (last.result?.status === "synced")
      return { kind: "synced", at: last.finishedAt, skipped: last.result.summary.skipped.length };
    return { kind: "never" };
  }

  updateStatus() {
    if (!this.statusEl) return;
    this.statusEl.setText(statusText(this.syncState, Date.now()));
    this.statusEl.setAttr("aria-label", "Google Drive Sync: click for the last sync log");
  }

  /** User edits schedule a debounced sync; the sync's own writes and out-of-scope paths do not. */
  private noteEdit(path: string) {
    if (this.runner.local.isSelf(path) || !inScope(path, this.scope)) return;
    this.controller.noteEdit();
  }

  get deviceName(): string {
    if (this.data.deviceName.trim()) return this.data.deviceName.trim();
    if (Platform.isIosApp) return Platform.isTablet ? "iPad" : "iPhone";
    if (Platform.isAndroidApp) return "Android";
    return Platform.isMacOS ? "Mac" : "Desktop";
  }

  get pluginDir(): string {
    return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
  }

  get scope(): ScopeSettings {
    return { configDir: this.app.vault.configDir, pluginDir: this.pluginDir, syncConfig: this.data.syncConfig };
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

  /** Tokens belong to the client that issued them, so a different client signs out. */
  async importClient(client: OAuthClient) {
    if (client.clientId !== this.data.clientId && this.data.tokens) await this.signOut();
    this.data.clientId = client.clientId;
    this.data.clientSecret = client.clientSecret;
    await this.save();
    this.initTokenManager();
  }

  async signIn() {
    if (!this.data.clientId || !this.data.clientSecret) {
      new Notice("Import your OAuth client JSON in the plugin settings first.");
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
