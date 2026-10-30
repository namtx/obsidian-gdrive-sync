Status: claimed
Type: task
Blocked by: 01

# Drive: OAuth PKCE with obsidian:// redirect

OAuth with PKCE using the user's own Google Cloud client, system browser consent, and `obsidian://` redirect handler. Scope `drive.file`. Refresh token stored in plugin `data.json`, excluded from sync. Document setup, including setting the OAuth app to In production to avoid 7-day token expiry.

Done when: sign-in works on macOS and iPhone, and the token refreshes after restart.

Spec: ../spec.md

## Comments

2026-10-30: Google rejects `obsidian://` as a redirect URI (Web clients need https, Desktop clients need a loopback server, which iOS lacks). Switched to a Web application client plus a GitHub Pages redirect page (`docs/oauth.html`) that forwards to `obsidian://gdrive-sync-auth`; spec updated. Implemented: src/drive/oauth.ts (PKCE, consent URL, code exchange, TokenManager refresh with persistence, invalid_grant → AuthExpiredError, revoke), src/obsidian/http.ts (requestUrl adapter), src/obsidian/settings.ts (client ID/secret, sign in/out), protocol handler in src/main.ts, setup in docs/setup-google-oauth.md. Unit tests: tests/drive-oauth.test.ts. Remaining before resolve: publish the GitHub Pages site, then sign in on macOS and iPhone and confirm the token refreshes after a restart.
