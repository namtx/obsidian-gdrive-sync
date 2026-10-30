Status: claimed
Type: task
Blocked by: 01

# Drive: OAuth PKCE with obsidian:// redirect

OAuth with PKCE using the user's own Google Cloud client, system browser consent, and `obsidian://` redirect handler. Scope `drive.file`. Refresh token stored in plugin `data.json`, excluded from sync. Document setup, including setting the OAuth app to In production to avoid 7-day token expiry.

Done when: sign-in works on macOS and iPhone, and the token refreshes after restart.

Spec: ../spec.md

## Comments

2026-10-30: Google rejects `obsidian://` as a redirect URI (Web clients need https, Desktop clients need a loopback server, which iOS lacks). Switched to a Web application client plus a GitHub Pages redirect page (`docs/oauth.html`) that forwards to `obsidian://gdrive-sync-auth`; spec updated. Implemented: src/drive/oauth.ts (PKCE, consent URL, code exchange, TokenManager refresh with persistence, invalid_grant → AuthExpiredError, revoke), src/obsidian/http.ts (requestUrl adapter), src/obsidian/settings.ts (client ID/secret, sign in/out), protocol handler in src/main.ts, setup in docs/setup-google-oauth.md. Unit tests: tests/drive-oauth.test.ts. Remaining before resolve: publish the GitHub Pages site, then sign in on macOS and iPhone and confirm the token refreshes after a restart.

2026-10-30: Repo https://github.com/namtx/obsidian-gdrive-sync created; Pages live from main /docs. The user site has custom domain namtx.dev, so https://namtx.github.io/obsidian-gdrive-sync/oauth.html 301-redirects to https://namtx.dev/obsidian-gdrive-sync/oauth.html with the query string kept; verified with curl. The registered redirect URI stays the github.io one. Remaining: real sign-in on macOS and iPhone.

2026-10-30: The user changed the registered redirect URI to https://namtx.dev/obsidian-gdrive-sync/oauth.html (the final URL, no 301 hop); REDIRECT_URI updated to match.

2026-10-30: macOS verified. The app had to be published (it was in Testing, giving "has not completed the Google verification process"). Sign-in succeeded; after a plugin reload the stored refresh token refreshed, the new token persisted to data.json, and Drive about.get returned 200. Remaining: sign-in on iPhone (with the BRAT build, ticket 15).
