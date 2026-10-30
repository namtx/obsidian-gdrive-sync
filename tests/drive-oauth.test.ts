import { describe, expect, it } from "vitest";
import type { HttpRequest, HttpResponse } from "../src/drive/http";
import {
  AuthExpiredError,
  finishAuth,
  parseClientJson,
  REDIRECT_URI,
  startAuth,
  TokenManager,
  type Tokens,
} from "../src/drive/oauth";

const client = { clientId: "cid.apps.googleusercontent.com", clientSecret: "secret" };

function fakeHttp(...responses: Array<{ status: number; body: unknown }>) {
  const requests: HttpRequest[] = [];
  const http = async (req: HttpRequest): Promise<HttpResponse> => {
    requests.push(req);
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    const text = JSON.stringify(next.body);
    return { status: next.status, headers: {}, text, arrayBuffer: new TextEncoder().encode(text).buffer };
  };
  return { http, requests, form: (i: number) => Object.fromEntries(new URLSearchParams(requests[i]!.body as string)) };
}

describe("startAuth", () => {
  it("builds a PKCE consent URL for the drive.file scope", async () => {
    const { url, pending } = await startAuth(client, 1000);
    const params = new URL(url).searchParams;

    expect(url.startsWith("https://accounts.google.com/o/oauth2/v2/auth?")).toBe(true);
    expect(params.get("client_id")).toBe(client.clientId);
    expect(params.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(params.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    expect(params.get("access_type")).toBe("offline");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("state")).toBe(pending.state);
    expect(pending.verifier).toMatch(/^[A-Za-z0-9_-]{64}$/);

    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pending.verifier));
    const expected = Buffer.from(digest).toString("base64url");
    expect(params.get("code_challenge")).toBe(expected);
  });

  it("uses a fresh verifier and state each time", async () => {
    const a = await startAuth(client);
    const b = await startAuth(client);
    expect(a.pending.verifier).not.toBe(b.pending.verifier);
    expect(a.pending.state).not.toBe(b.pending.state);
  });
});

describe("parseClientJson", () => {
  const web = {
    client_id: "cid.apps.googleusercontent.com",
    project_id: "obsidian-sync",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    client_secret: "GOCSPX-abc",
    redirect_uris: [REDIRECT_URI],
  };

  it("reads the client ID and secret from a Web client file", () => {
    expect(parseClientJson(JSON.stringify({ web }))).toEqual({
      clientId: "cid.apps.googleusercontent.com",
      clientSecret: "GOCSPX-abc",
    });
  });

  it("explains what is wrong with other files", () => {
    expect(() => parseClientJson("not json")).toThrow(/Not a JSON file/);
    expect(() => parseClientJson(JSON.stringify({ installed: web }))).toThrow(/Desktop client/);
    expect(() => parseClientJson(JSON.stringify({ web: { client_id: "x" } }))).toThrow(/no client ID and secret/);
    expect(() => parseClientJson(JSON.stringify({ web: { ...web, redirect_uris: [] } }))).toThrow(REDIRECT_URI);
  });
});

describe("finishAuth", () => {
  const pending = { verifier: "v".repeat(64), state: "st", createdAt: 0 };

  it("exchanges the code with the verifier and secret", async () => {
    const { http, form } = fakeHttp({
      status: 200,
      body: { access_token: "at", expires_in: 3600, refresh_token: "rt" },
    });

    const tokens = await finishAuth(http, client, pending, { code: "c0de", state: "st" }, 1000);

    expect(tokens).toEqual({ accessToken: "at", expiresAt: 1000 + 3_600_000, refreshToken: "rt" });
    expect(form(0)).toEqual({
      grant_type: "authorization_code",
      code: "c0de",
      code_verifier: pending.verifier,
      redirect_uri: REDIRECT_URI,
      client_id: client.clientId,
      client_secret: "secret",
    });
  });

  it("rejects a mismatched state without calling Google", async () => {
    const { http, requests } = fakeHttp();
    await expect(finishAuth(http, client, pending, { code: "c", state: "other" }, 1000)).rejects.toThrow(/does not match/);
    expect(requests).toEqual([]);
  });

  it("rejects when no sign-in is pending, the user denied access, or it expired", async () => {
    const { http } = fakeHttp();
    await expect(finishAuth(http, client, null, { code: "c", state: "st" })).rejects.toThrow(/No sign-in/);
    await expect(finishAuth(http, client, pending, { error: "access_denied" })).rejects.toThrow(/access_denied/);
    await expect(finishAuth(http, client, pending, { code: "c", state: "st" }, 11 * 60_000)).rejects.toThrow(/too long/);
  });

  it("fails when Google returns no refresh token", async () => {
    const { http } = fakeHttp({ status: 200, body: { access_token: "at", expires_in: 3600 } });
    await expect(finishAuth(http, client, pending, { code: "c", state: "st" }, 0)).rejects.toThrow(/refresh token/);
  });
});

describe("TokenManager", () => {
  const tokens: Tokens = { accessToken: "old", expiresAt: 100_000, refreshToken: "rt" };

  it("reuses a valid access token", async () => {
    const { http, requests } = fakeHttp();
    const tm = new TokenManager(http, client, tokens, async () => {}, () => 0);
    expect(await tm.accessToken()).toBe("old");
    expect(requests).toEqual([]);
  });

  it("refreshes near expiry, keeps the refresh token, and persists", async () => {
    const { http, form } = fakeHttp({ status: 200, body: { access_token: "new", expires_in: 3600 } });
    const saved: Tokens[] = [];
    const tm = new TokenManager(http, client, tokens, async (t) => void saved.push(t), () => 50_000);

    expect(await tm.accessToken()).toBe("new");
    expect(form(0)).toMatchObject({ grant_type: "refresh_token", refresh_token: "rt" });
    expect(saved).toEqual([{ accessToken: "new", expiresAt: 50_000 + 3_600_000, refreshToken: "rt" }]);
  });

  it("shares one refresh between concurrent callers", async () => {
    const { http, requests } = fakeHttp({ status: 200, body: { access_token: "new", expires_in: 3600 } });
    const tm = new TokenManager(http, client, tokens, async () => {}, () => 99_000);
    expect(await Promise.all([tm.accessToken(), tm.accessToken()])).toEqual(["new", "new"]);
    expect(requests).toHaveLength(1);
  });

  it("reports a revoked refresh token as needing sign-in", async () => {
    const { http } = fakeHttp({ status: 400, body: { error: "invalid_grant" } });
    const tm = new TokenManager(http, client, tokens, async () => {}, () => 99_000);
    await expect(tm.accessToken()).rejects.toBeInstanceOf(AuthExpiredError);
  });
});
