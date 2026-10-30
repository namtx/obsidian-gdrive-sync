import { HttpError, type Http } from "./http";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const REDIRECT_URI = "https://namtx.github.io/obsidian-gdrive-sync/oauth.html";
/** The redirect page forwards to `obsidian://<PROTOCOL_ACTION>?code=…&state=…`. */
export const PROTOCOL_ACTION = "gdrive-sync-auth";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

/** Kept until the browser comes back, so it survives Obsidian being suspended on iOS. */
export interface PendingAuth {
  verifier: string;
  state: string;
  createdAt: number;
}

export interface Tokens {
  accessToken: string;
  /** Milliseconds since epoch. */
  expiresAt: number;
  refreshToken: string;
}

/** The refresh token was revoked or expired; the user must sign in again. */
export class AuthExpiredError extends Error {
  constructor(detail: string) {
    super(`Google sign-in expired, sign in again (${detail})`);
  }
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(bytes: number): string {
  return base64url(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function startAuth(client: OAuthClient, now = Date.now()): Promise<{ url: string; pending: PendingAuth }> {
  const verifier = randomString(48);
  const state = randomString(16);
  const challenge = base64url(
    new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: DRIVE_SCOPE,
    // Offline access + forced consent so Google always returns a refresh token.
    access_type: "offline",
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return { url: `${AUTH_ENDPOINT}?${params}`, pending: { verifier, state, createdAt: now } };
}

/** Validate the redirect and exchange the code for tokens. */
export async function finishAuth(
  http: Http,
  client: OAuthClient,
  pending: PendingAuth | null,
  params: Record<string, string | undefined>,
  now = Date.now(),
): Promise<Tokens> {
  if (params.error) throw new Error(`Google sign-in failed: ${params.error}`);
  if (!pending) throw new Error("No sign-in in progress; start sign-in from the plugin settings");
  if (params.state !== pending.state) throw new Error("Sign-in response does not match the request; try again");
  if (now - pending.createdAt > 10 * 60_000) throw new Error("Sign-in took too long; try again");
  if (!params.code) throw new Error("Sign-in response has no code");

  const json = await postForm(http, {
    grant_type: "authorization_code",
    code: params.code,
    code_verifier: pending.verifier,
    redirect_uri: REDIRECT_URI,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  });
  if (!json.refresh_token) throw new Error("Google did not return a refresh token");
  return { accessToken: json.access_token, expiresAt: now + json.expires_in * 1000, refreshToken: json.refresh_token };
}

export async function revoke(http: Http, refreshToken: string): Promise<void> {
  await http({
    url: REVOKE_ENDPOINT,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: refreshToken }).toString(),
  });
}

/** Hands out a valid access token, refreshing it shortly before expiry. */
export class TokenManager {
  private refreshing: Promise<Tokens> | null = null;

  constructor(
    private http: Http,
    private client: OAuthClient,
    private tokens: Tokens,
    /** Persist rotated tokens. */
    private save: (tokens: Tokens) => Promise<void>,
    private now: () => number = Date.now,
  ) {}

  async accessToken(): Promise<string> {
    if (this.tokens.expiresAt - 60_000 > this.now()) return this.tokens.accessToken;
    return (await this.refresh()).accessToken;
  }

  /** Force a refresh, e.g. after a 401. Concurrent callers share one request. */
  refresh(): Promise<Tokens> {
    this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async doRefresh(): Promise<Tokens> {
    const json = await postForm(this.http, {
      grant_type: "refresh_token",
      refresh_token: this.tokens.refreshToken,
      client_id: this.client.clientId,
      client_secret: this.client.clientSecret,
    });
    this.tokens = {
      accessToken: json.access_token,
      expiresAt: this.now() + json.expires_in * 1000,
      // Google usually omits the refresh token on refresh; keep the old one.
      refreshToken: json.refresh_token ?? this.tokens.refreshToken,
    };
    await this.save(this.tokens);
    return this.tokens;
  }
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

async function postForm(http: Http, form: Record<string, string>): Promise<TokenResponse> {
  const res = await http({
    url: TOKEN_ENDPOINT,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  if (res.status === 400 || res.status === 401) {
    let error = "";
    try {
      error = JSON.parse(res.text).error ?? "";
    } catch {}
    if (error === "invalid_grant") throw new AuthExpiredError(error);
  }
  if (res.status !== 200) throw new HttpError(res.status, res.text, "Google token request");
  return JSON.parse(res.text) as TokenResponse;
}
