# Google OAuth setup

The plugin signs in with your own Google Cloud OAuth client. Do this once; every device uses the same client.

## Google Cloud Console

1. Create a project at https://console.cloud.google.com (e.g. `Obsidian Sync`).
2. **APIs & Services → Library**: enable **Google Drive API**.
3. **Google Auth Platform → Get started**: app name, support email, audience **External**, contact email.
4. **Data Access → Add or remove scopes**: add `https://www.googleapis.com/auth/drive.file`. This scope only sees files the plugin created, and it is non-sensitive, so no Google review is needed.
5. **Audience → Publish app** so the status is **In production**. In Testing mode, refresh tokens expire after 7 days. Google may show "Google hasn't verified this app" at sign-in; choose **Advanced → Go to …**.
6. **Clients → Create client**, type **Web application**, authorized redirect URI:
   `https://namtx.dev/obsidian-gdrive-sync/oauth.html`
7. **Download JSON** for the client. Keep it in a password manager, never commit it.

## Why a redirect page

Google does not accept `obsidian://` as a redirect URI: Web clients need `https://`, and Desktop clients need a loopback server, which iOS can't run. Google redirects to `docs/oauth.html` (served by GitHub Pages), which immediately forwards `code` and `state` to `obsidian://gdrive-sync-auth`. The page stores and sends nothing. The code alone is useless: the token exchange also needs the PKCE verifier, which never leaves the device, and the client secret.

GitHub Pages: repository `namtx/obsidian-gdrive-sync`, **Settings → Pages → Deploy from a branch → `main` / `/docs`**.

## In Obsidian (each device)

1. **Settings → Google Drive Sync → Import client JSON**: pick the downloaded file (on iPhone, from the Files app). The plugin checks that it is a Web application client with the redirect URI above, and keeps the ID and secret in `data.json`; the file itself can be deleted afterwards.
2. **Sign in**. The browser opens Google consent, then returns to Obsidian.
3. Tokens are stored in `.obsidian/plugins/gdrive-sync/data.json` on that device only. The plugin never syncs this file.
